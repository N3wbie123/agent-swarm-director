# ACP(Agent Client Protocol) 아키텍처 및 추후 GUI 연동 관리 문서 (`docs/ACP_ROADMAP.md`)

> **기준 버전**: ASD v2.7.0  
> **목적**: Core 리포(`asd-multiagent`)에 완료된 **ACP v1 클라이언트 + v2 호환 계층 / 하이브리드 Dispatch / OpenCode 비동기 완료 콜백** 구조와, 추후 **GUI(`ASD-Nexus` / `asd-gui`) 및 `runDriverTurn` 고도화 단계에서 진행할 이월 항목**을 한눈에 관리하기 위한 기준 문서.

---

## 1. 핵심 설계 결정 요약

| 결정 항목 | 채택 방안 | 근거 |
| :--- | :--- | :--- |
| **ACP 구현 방식** | **순수 직접 구현 (Zero-Dependency, `dependencies: {}` 유지)** | `@agentclientprotocol/sdk`가 런타임 `zod`에 의존하고, 무설치 `git pull`(`asd update`) 환경에서 `tsc --noEmit` 깨짐 및 Hook 콜드스타트 지연을 유발하므로 `src/core/acp-types.ts` + `src/core/acp-client.ts`로 직접 구현 |
| **기존 CLI Dispatch 존속 여부** | **하이브리드 (`ACP Primary + Hardened Streaming CLI Fallback`)** | OpenCode·Antigravity·Cursor는 네이티브 ACP를 즉시 사용하고, 외부 브리지 미설치 환경의 Claude Code·Codex 및 커스텀 `CommandRunner` 목업 테스트는 수정된 스트리밍 CLI 폴백으로 무중단 동작 |
| **OpenCode 메인 세션 멈춤 해결** | **`asd dispatch --async` + `asd-guard.js` (`client.session.prompt`) 자동 콜백** | OpenCode에는 백그라운드 셸 태스크가 없으므로, 백그라운드 워커 프로세스를 분리(`--async`)해 100ms 내 반환하고 완료 시 OpenCode 플러그인이 메인 세션에 결과를 능동 주입 |
| **GUI 드라이버(`runDriverTurn`) 범위** | **현행 유지 (이월 관리)** | `src/core/drivers.ts`의 `runDriverTurn`은 외부 GUI 앱(`ASD-Nexus` / `asd-gui`)과의 하위 호환성을 위해 이번 Core 개편에서 변경하지 않고 본 문서 섹션 4에 체크리스트로 관리 |

---

## 2. Core 구현 완료 내역 (v2.7.0)

### 2.1 무의존성 ACP 클라이언트 엔진 (`src/core/acp-types.ts`, `src/core/acp-client.ts`)
- **프로토콜 협상**: ACP v1(`protocolVersion: 1`, `clientCapabilities: {}`) 기본 핸드셰이크 + ACP v2 초안(즉시 ACK 후 비동기 `session/update` idle/turn_complete 완료 신호) 호환 어댑터 내장.
- **세션 수명주기**: `session/new`, `session/load`(일시적 idle stall 발생 시 동일 워크트리 제자리 재개), `session/set_model` 및 `session/set_config_option`(모델·추론 강도 설정), `session/cancel` 협조적 취소 및 프로세스 트리 정리.
- **양방향 보안 게이트 (`evaluateAcpPermissionRequest`)**: 서브에이전트가 파일 수정·명령 실행 시 보내는 `session/request_permission` JSON-RPC 요청을 `policy.ts`(`evaluatePreToolUse`, `allowedFiles` 경계, `.git/`·`.asd/`·`.env*` 보호 경로, `scout`/`critic` 읽기 전용 역할 강제)로 즉시 판정하여 허용/거부 응답 반환.
- **Windows 실행 안전성 (`resolveAcpLaunchCommand`)**: `.exe`, `.cmd`/`.bat`(Node 진입점 직접 추출 포함), `.ps1`(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`)을 `shell: false`로 안전 실행하여 stdio JSON-RPC 스트림 오염 방지.

### 2.2 하네스별 ACP 지원 매트릭스 및 외부 브리지 설치 안내

`asd doctor` 및 `asd sync` 실행 시 각 하네스의 ACP 준비 상태를 자동 점검합니다.

| 하네스 | 기본 실행 경로 | ACP 명령 | 미설치 시 동작 및 안내 |
| :--- | :--- | :--- | :--- |
| **OpenCode** | 네이티브 ACP | `opencode acp --pure` | 기본 CLI 설치 시 즉시 ACP 동작 |
| **Antigravity** | 네이티브 ACP | `agy acp --dangerously-skip-permissions` | 기본 CLI 설치 시 즉시 ACP 동작 |
| **Cursor CLI** | 네이티브 ACP | `cursor-agent acp` / `agent acp` | `.ps1` 래퍼 자동 해석 포함 즉시 ACP 동작 |
| **Claude Code** | 외부 공식 브리지 (선택) | `claude-agent-acp` | 미설치 시 스트리밍 CLI(`claude -p --output-format stream-json`) 자동 폴백. ACP 활성화 시: `npm i -g @agentclientprotocol/claude-agent-acp` |
| **Codex CLI** | 외부 공식 브리지 (선택) | `codex-acp` | 미설치 시 스트리밍 CLI(`codex exec --json --full-auto`) 자동 폴백. ACP 활성화 시: `npm i -g @agentclientprotocol/codex-acp` |

> 두 외부 브리지를 한 번에 설치하려면:
> ```bash
> npm i -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp
> ```

### 2.3 강화된 스트리밍 CLI 폴백 (`src/core/session-tracker.ts`, `src/core/spawner.ts`)
- **출력 버퍼링/멈춤 해소**: CLI 폴백 시 전 하네스 실시간 NDJSON 스트리밍(`stream-json` / `--json`) 적용 및 헤드리스 실행 시 `closeStdinOnSpawn: true` 기본화.
- **권한 프롬프트 멈춤 차단**: 비대화형 헤드리스 스폰 시 Antigravity/Claude `--dangerously-skip-permissions`, Codex `--full-auto`, OpenCode `--pure` 기본 부여, 비-Cursor 하네스의 `model: "default"` 자동 정규화.
- **슬라이딩 타임아웃 및 원인 분리**: 실시간 스트림 청크 수신 시 전체 타임아웃을 연장(`allowSlidingTimeout`)하고, 진짜 무응답 멈춤(`timeoutReason: "idle"`)과 상한 초과(`"wall_clock"`)를 구분. 일시적 `"idle"` 타임아웃 발생 시 획득된 `sessionId`로 동일 워크트리에서 1회 즉시 이어하기(`session/load` 또는 CLI resume) 수행.

### 2.4 OpenCode 비동기 Dispatch 및 자동 완료 보고 (`--async` + `asd-guard.js`)
1. OpenCode 메인 에이전트가 `asd dispatch --turn <N> --mode parallel_spawn --async`를 실행하면 분리된(detached) 백그라운드 워커를 띄우고 `.asd/sessions/<sessionId>/async-dispatch.json`에 `"running"` 상태를 기록한 뒤 **100ms 이내에 즉시 종료**됩니다.
2. 메인 세션이 멈추지 않으므로 사용자는 실행 도중에도 메인 에이전트와 자유롭게 대화하거나 `asd status`를 조회할 수 있습니다.
3. 백그라운드 워커가 서브에이전트 실행 및 `verify` 게이트를 마치면 `async-dispatch.json`을 `"done"` 또는 `"failed"`로 갱신합니다.
4. `~/.config/opencode/plugin/asd-guard.js` 플러그인이 이를 감지하고, 메인 세션이 유휴(`session.idle`) 상태일 때 `client.session.prompt({ path: { id: sessionID }, body: { noReply: false, parts: [{ type: "text", text: report }] } })`를 정확히 1회(`notified: true`) 호출하여 메인 에이전트가 자동으로 다음 Wave 또는 최종 요약을 이어갑니다.
5. 수동 대기가 필요한 스크립트/터미널 환경을 위해 `asd wait [--session <id>] [--timeout <ms>]` 및 `--transport <auto|acp|cli>` 플래그도 함께 제공됩니다.

---

## 3. 관련 핵심 파일 색인

- `src/core/acp-types.ts`: ACP v1 표준 JSON-RPC 메시지/이벤트 타입 및 v2 호환 타입 정의
- `src/core/acp-client.ts`: `AcpStdioClient`, `probeAcpCapability`, `evaluateAcpPermissionRequest`, `executeAcpSubagentTurn`
- `src/mcp/server.ts`: `handleDispatch` 하이브리드 실행, 제자리 `session/load` 재개, `--async` 백그라운드 워커 분리
- `src/core/debate.ts` / `src/core/subagent-control.ts`: 블라인드 토론 브로커·서브에이전트 제어 하이브리드 실행 및 `waitForAsyncDispatch`
- `src/adapters/opencode.ts`: `generateOpencodeGuardPlugin` (`client.session.prompt` 비동기 완료 콜백)
- `src/adapters/installer.ts` / `src/cli/index.ts`: `asd doctor`, `asd sync`, `asd dispatch --async --transport`, `asd wait`

---

## 4. 추후 진행 항목 체크리스트 — GUI (`ASD-Nexus` / `asd-gui`) 및 `runDriverTurn`

> [!IMPORTANT]
> 아래 항목들은 외부 GUI 리포(`ASD-Nexus` / `asd-gui`) 작업 시점에 맞춰 순차 진행하기 위해 의도적으로 분리·보류된 항목입니다.

- [ ] **G1. `runDriverTurn` (`src/core/drivers.ts`) 상주형 멀티턴 ACP 세션 옵션 도입**
  - 현재 `runDriverTurn`은 매 턴 CLI 프로세스를 새로 스폰(`--resume`)하는 단발 스트리밍 구조임.
  - `AcpStdioClient`를 상주 세션 풀(`DriverSessionPool`)로 유지하여 매 턴 프로세스 콜드부트(특히 OpenCode ~28초 부팅 비용) 없이 즉시 `session/prompt`를 전송하도록 확장 (`transport?: "auto" | "acp" | "cli"` 옵션 추가, 기본값은 GUI 준비 완료 전까지 하위 호환 유지).
- [ ] **G2. `AcpNormalizedEvent` ↔ `DriverStreamEvent` 실시간 스트림 단일화**
  - `src/core/acp-client.ts`의 `normalizeAcpSessionUpdate`(`text`, `thinking`, `tool_use`, `tool_result`, `state`)를 `DriverStreamEvent` 콜백(`onEvent`)에 무손실 매핑하여 GUI 채팅창에서 5대 하네스 동일 UX 렌더링 보장.
- [ ] **G3. GUI 대화형 권한 승인 모달 연동 (`session/request_permission` Interactive Mode)**
  - 헤드리스 서브에이전트는 `policy.ts`가 자동 판정하지만, 사용자가 직접 조작하는 GUI 메인 드라이버 세션에서는 `session/request_permission` 수신 시 WebSocket/IPC를 통해 GUI 승인 모달(`allow_once` / `allow_always` / `reject_once`)을 띄우고 사용자 선택 결과를 ACP 응답으로 반환하도록 브리지 추가.
- [ ] **G4. GUI 실행 중 즉시 중단 버튼 (`session/cancel`) 직결**
  - 기존 프로세스 강제 종료(`killProcessTree`) 대신 ACP `session/cancel` 알림을 먼저 전송해 하네스 세션 DB 손상 없이 현재 턴만 깔끔히 중단하고 프로세스는 유지.
- [ ] **G5. GUI 설정 화면 내 ACP 상태 배지 및 원클릭 브리지 설치 도우미**
  - `runAsdDoctor()`가 반환하는 `harnesses[id].acp` 및 `acpBridgeHints` 필드를 GUI 환경설정 패널에 표시하고, Claude Code / Codex 브리지 미설치 시 안내 배너 노출.
- [ ] **G6. ACP v2 정식 스펙 승격 대응**
  - 업스트림 ACP v2 스펙이 초안(`draft`)에서 정식 확정되면 `src/core/acp-types.ts` 및 `preferredProtocolVersion` 기본값을 v2로 승격하고 구버전 하네스용 v1 협상 폴백 유지.
