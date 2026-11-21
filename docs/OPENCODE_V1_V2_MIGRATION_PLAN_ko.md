# OpenCode V1/V2 지원 전략 및 V1 동결 이주 계획 (OPENCODE_V1_V2_MIGRATION_PLAN_ko.md)

[English](./OPENCODE_V1_V2_MIGRATION_PLAN.md) | **한국어**

> **작성일**: 2026-11-21
> **기준 커밋**: `2dceeae` (main)
> **목적**: OpenCode V1/V2 공존 상황에서 ASD의 지원 정책, V1 전용 코드 인벤토리, V2 이주 및 V1 동결·제거 계획을 정의한다.
> **성격**: 진행 중 (세션 `asd-20261121-212400-ocv2`, Debate `D-mwqdzqsd-NGID` 반영). 로컬 OpenCode를 V1 `1.19.4`에서 V2 `opencode v2.3.2`(`@opencode/cli@2.3.2`)로 안전 교체 완료. 외부 검증 백업 경로: `~/.asd/backups/opencode-v1-pre-upgrade-20261121-213700/` (최상위 설정 20개 + V1 `opencode.exe` SHA-256 일치). 기존 `~/.config/opencode/` 사용자 설정은 V2 자동 변환으로 정상 로드되어 삭제·수정 불필요. **과도기 주의**: Phase 2(`T4.1`/`T6.1`) 완료 전까지 로컬 OpenCode V2에는 ASD PreToolUse/Stop 정책 가드가 미적용 상태임.

---

## 1. 결정 요약

| 항목 | 결정 |
|---|---|
| V2 | 정식 지원. 신규 기능·훅/플러그인 개발의 유일한 대상 |
| V1 | 호환 모드로 동결. 신규 기능 없음. 보안/치명 버그 및 공용 코드 변경으로 인한 호환 깨짐만 수정 |
| 전제 조건 | `opencode --version` 기반 버전 감지 + capability 프로파일 도입 |
| 제거 트리거 | 공식 V1 EOL 또는 V1 사용률 한 자릿수 도달 중 먼저 오는 시점. README에 사전 공지 |
| 금지 사항 | `8468491` 커밋 통째 삭제 금지. 해당 커밋에는 ACP 하이브리드 Dispatch, in-place idle resume, 공용 `--async`가 함께 포함됨 |

**핵심 판단**: V1 전용 코드는 `src/adapters/opencode.ts`와 소수 필드/플래그/문서에 집중되어 있어 격리 비용이 낮다. 반면 V2는 플러그인 API가 breaking이므로 **V2 훅 시스템은 어차피 신규 개발이 필요**하다. 따라서 "V2 우선 개발 + V1 동결 지원"이 유지보수 비용과 사용자 이탈 리스크의 균형점이다.

---

## 2. 확인된 사실

### 2.1 외부 사실 (OpenCode 공식/공개 자료)

| 항목 | 상태 | 비고 |
|---|---|---|
| V1 자동 업데이트 | v1.19.0부터 중단 | 업데이트를 수동으로 실행해야 함 |
| V1 → V2 업그레이드 | v1.19.6부터 공식 안내 | V2를 백그라운드 다운로드 후 사용자가 선택해 설치 |
| V2 메인라인 | 2.x 체인지로그 운영 | 2026-10에 2.0 공개, 2026-11 기준 2.3.x |
| V2 백그라운드 태스크 | v2.3.0부터 서브에이전트 기본 백그라운드, 셸 명령 백그라운드 지원 | 메인 세션 프리즈 문제를 네이티브로 해소 |
| V2 breaking change | 플러그인 API, 서버 API, 터미널 설정 파일(`cli.json`) | V1 플러그인은 V2에서 로드되지 않음 |
| V1/V2 설치 관계 | 동일한 `opencode` 명령·설정 경로 공유, 기본 병행 설치 아님 | 런타임 버전 감지 필수 |
| V1 EOL 일정 | 공식 확인 안 됨 | 계획에서는 **가정**으로 취급 |
| V1 1.x 패치 | 아직 제공되는 것으로 보임 | 외부 보도 기준. 공식 보증 아님 |

### 2.2 코드베이스 사실

| 항목 | 상태 | 근거 |
|---|---|---|
| OpenCode 버전 감지 | 없음 | 코드베이스 전체에 `opencode --version` 프로브 없음 |
| V1/V2 구분 | 없음 | 하네스 ID는 단일 `"opencode"` (`src/core/types.ts:78`) |
| V2 플러그인 API 구현 | 없음 | V1 플러그인만 존재 (`src/adapters/opencode.ts:90-366`) |
| V2 정책 가드 | **공백** | V1 플러그인이 V2에서 로드되지 않으므로 PreToolUse/Stop 가드가 없음 |
| 공용 async Dispatch | 존재 | 하네스 비종속 경로 (`src/orchestrator/dispatch-handler.ts:823`) |
| V1 전용 완료 콜백 | 존재 | `asd-guard.js` + `openCodeSessionId` 배관 |

---

## 3. 코드 인벤토리

### 3.1 V1 전용 (격리·동결·추후 삭제 대상)

#### A. `asd-guard.js` V1 플러그인 전체

V1 플러그인 API(`tool.execute.before`, `session.idle`, `client.session.prompt`)에 의존하므로 V2에서 동작하지 않는다. 정책 훅과 async 완료 콜백을 **모두** 담당하므로, V2 대체 훅이 준비되기 전에 제거하면 정책 가드 공백이 발생한다.

| 구성 요소 | 위치 | 내용 |
|---|---|---|
| 플러그인 생성기 | `src/adapters/opencode.ts:90-366` | V1 플러그인 소스 문자열 생성 |
| 정책 훅 배선 | `src/adapters/opencode.ts:309-361` | `tool.execute.before` → `asd hook pre-tool-use`, `session.idle` → `asd hook stop`, `session.status` busy/idle 추적 |
| async 완료 감시·주입 | `src/adapters/opencode.ts:195-292` | `.asd/sessions/*/async-dispatch.json` 폴링 후 `client.session.prompt`로 메인 세션에 보고 주입 |
| Bun 런타임 우회 | `src/adapters/opencode.ts:84-116` | `process.execPath`가 `opencode.exe`를 가리키는 문제를 피하기 위해 Node 경로를 baking |
| 설치/삭제/해시/doctor 문구 | `src/adapters/installer.ts:1195-1197`, `:2078`, `:793`, `:2514` | `~/.config/opencode/plugin/asd-guard.js` 관리 |

#### B. V1 완료 콜백용 세션 ID 배관

| 항목 | 위치 |
|---|---|
| `AsyncDispatchJobMeta.openCodeSessionId`, `notified`, `notifyAttempts` | `src/core/types.ts:352-353` |
| `AsdDispatchInput.openCodeSessionId` | `src/core/types.ts:381` |
| `--opencode-session` 파싱·전달 | `src/cli/index.ts:166`, `:345-349`, `:2076` |
| async job에 세션 ID 기록 | `src/orchestrator/dispatch-handler.ts:845` |

#### C. V1 전용 스킬 지시문

| 항목 | 위치 |
|---|---|
| "OpenCode Non-Blocking Rule": 항상 `--async` + `asd-guard.js` 자동 알림 | `src/skills/asd-run/SKILL.md:51` |
| "MUST pass `--async`" | `src/skills/asd/SKILL.md:57` |
| 설치 검증 assertion | `tests/installer-sync.test.ts:1584` |

#### D. V1 전용 문서 서술

| 항목 | 위치 |
|---|---|
| README의 OpenCode async 설명·명령 예시·HEAVY 표 | `README.md:24`, `:70-71`, `:109`, `:123-124` |
| 한국어 README 동일 항목 | `README_ko.md` 동일 라인 |
| ACP 로드맵의 OpenCode 프리즈 해결 서술 | `docs/ACP_ROADMAP.md:16`, `:51-55` |
| 한국어 ACP 로드맵 동일 항목 | `docs/ACP_ROADMAP_ko.md` 동일 라인 |

### 3.2 V1 때문에 만들었지만 공용인 것 (유지)

| 항목 | 위치 | 비고 |
|---|---|---|
| `--async` detached worker, `async-dispatch.json` | `src/orchestrator/dispatch-handler.ts:823-950` | 하네스 게이트 없음. 모든 하네스 사용 가능 |
| job 영속화·폴링 헬퍼 | `src/core/subagent-control.ts:800-880` | `asd wait`가 사용 |
| `asd wait`, `asd status` asyncJob 표시 | `src/cli/index.ts:272`, `:1311`, `:1427`, `:2085-2100` | 공용 CLI 표면 |
| 테스트 | `tests/cli-commands.test.ts:355`, `tests/orchestrator.test.ts:1786` | 공용 동작 검증 |

**원칙**: 엔진은 공용으로 유지하고, V1 전용은 "완료 콜백" 계층에만 한정한다.

### 3.3 OpenCode 공용 어댑터 표면 (Phase 0 `opencode v2.3.2` 실측 검증 완료)

| # | 기능 | 위치 | V2 상태 |
|---|---|---|---|
| 1 | Headless run: `opencode run --format json [--pure] [--model]` | `src/core/session-tracker.ts:179-183`, `src/core/spawner.ts:366,425` | **대체 필요**: `--format json`, `--model` 지원; `--pure` 제거됨 (V2에서는 `--auto` 사용) |
| 2 | Headless resume: `opencode run --session <sid>` | `src/core/session-tracker.ts:250-261` | **지원**: `opencode run --session <sid>` (`-s`) 유지 |
| 3 | 대화형 resume: `opencode --session <sid>` | `src/core/session-tracker.ts:335-339` | **지원**: `opencode --session <sid>` (`-s`) 유지 |
| 4 | ACP: `opencode acp --pure` | `src/core/acp-client.ts:249-258` | **대체 필요**: `--pure` 실패(종료코드 1: `Unrecognized flag: --pure`); `opencode acp` 네이티브 정상 동작(`protocolVersion: 1`, `loadSession: true`) |
| 5 | 모델 탐색: `opencode models` | `src/core/models.ts:518-533` | **지원**: `opencode.jsonc` 커스텀 프로바이더 포함 `provider/model` 목록 정상 출력 |
| 6 | 설정 스캔: `opencode.json/jsonc`, `agent/*.md` | `src/core/models.ts:367-441`, `src/adapters/installer.ts:1199-1258` | **지원 (주의점 있음)**: V2가 `opencode.json(c)`를 읽고 V1 `mcp`/`plugin`/`agent`/`provider`를 자동 정규화; `mcpServers` 무시(`mcp.servers` 사용), `_asdVersion` 무시, TUI 설정은 `cli.json`으로 분리 |
| 7 | `oh-my-openagent.json` 감지·정리 | `src/adapters/installer.ts:1261-1271`, `:2094-2119` | **지원 (버그 수정 필요)**: 구조 동일; uninstall 시 `installer.ts:2104`를 `parseJsonc`로 수정 필요 |
| 8 | 세션 DB/트랜스크립트: `opencode.db`, storage JSON 폴백 | `src/core/session-tracker.ts:1402-1406`, `src/core/transcripts.ts:1071-1169`, `:1459-1516` | **대체 필요**: `opencode.db`에 V1 테이블(`session`, `message`, `part`) 외 V2 테이블(`session_v2`, `session_message` 내부 `data.content[]`, `session_part`) 추가됨 |
| 9 | `ses_` 세션 ID 귀속 보정 | `src/core/session-tracker.ts:1516-1526` | **지원**: V2 `session_v2.id`도 `ses_*` 형식 유지 |
| 10 | daemon-sse: `opencode serve` SSE 파서 + `/session/:id/abort` | `src/core/spawner.ts:829-846`, `src/adapters/opencode.ts:16-58`, `src/core/drivers.ts:611-650`, `src/core/types.ts:517` | **대체 필요**: V2 OpenAPI(`/openapi.json`, 142개 경로)에서 SSE는 `/api/event`, abort는 `/api/session/{sessionID}/interrupt`로 변경 |
| 11 | 모델 기본값/표기 | `src/core/router.ts:224,667,710`, `src/core/drivers.ts:517-518`, `src/core/debate.ts:918`, `src/core/models.ts:799-800` | **지원**: `provider/model` (선택 `#variant`) 형식 유지 |
| 12 | 정책 도구명: `write/edit/patch/multiedit`, `bash` | `src/core/policy.ts:74-78` | **대체 필요**: V2 `ctx.tool.list()` 실측 결과 쓰기 도구는 `write`/`edit`/`patch`, 셸 도구명이 `bash` → `shell`로 변경 |
| 13 | 설치 대상: `command/`, `agent/`, `AGENTS.md`, `opencode.json` | `src/adapters/installer.ts:1165-1191`, `src/adapters/opencode.ts:403-418` | **대체 필요 (플러그인 경로)**: `command/`, `agent/`, `AGENTS.md`, `opencode.json(c)` 호환 유지; V2 플러그인은 `plugins/<name>/index.js`로 `opencode.json(c)` 수정 없이 자동 로드되며 단일 파일 `plugin/asd-guard.js`는 무시됨 |
| 14 | 에이전트 frontmatter: `mode: subagent`, read-only `tools:` | `src/adapters/installer/agent-renderer.ts:162-170` | **지원**: `opencode debug agents`에서 `tools: { write/edit/patch: false }`가 `{ action: "edit", resource: "*", effect: "deny" }`로 자동 변환됨 확인 |
| 15 | ACP 준비 상태 프로브 | `src/adapters/installer.ts:2438-2458` | **대체 필요**: V2는 `["acp"]`, V1은 `["acp", "--pure"]`로 분기 필요 |
| 16 | 대시보드 모델 피커/라벨 | `src/cli/dashboard.ts` | **지원**: 공용 UI가 `provider/model` 카탈로그를 그대로 소비 |

#### Phase 0 실측 V2 플러그인 및 런타임 계약 (`opencode v2.3.2`)
- **버전 문자열 형식**: V1은 bare semver(`1.19.4`), V2는 `opencode v2.3.2` 출력(종료코드 `0`).
- **Zero-Dep V2 플러그인**: `@opencode/plugin@2.3.2`의 `Plugin.define(p)`는 항등 함수이며, `~/.config/opencode/plugins/asd-guard/index.js`에 순수 ESM 객체(`export default { id: "asd-policy-guard", async setup(ctx) { ... } }`)를 배치하면 외부 npm 의존성(`dependencies: {}` 유지) 및 `opencode.json(c)` 수정 없이 자동 로드됨을 실증 완료.
- **V2에서도 Bun `process.execPath` 이슈 동일 확인**: Windows V2 플러그인 내부에서 `process.execPath`가 `...\@opencode\cli\bin\opencode.exe`를 가리키므로 sync 시 Node 바이너리 경로 baking이 필수.
- **V2 훅 API**:
  - PreToolUse: `await ctx.tool.hook("execute.before", (event) => { ... throw new Error(reason); })` (`event = { tool, sessionID, agent, messageID, id, input }`, 루트 디렉토리 `ctx.location?.directory || process.cwd()`).
  - Stop: `ctx.event.subscribe({ signal: controller.signal })`로 `event.type === "session.idle"` 수신, cleanup으로 `() => controller.abort()` 반환.
  - 잔여 V1 `plugin/asd-guard.js`: V2에서 충돌 없이 무시되나 `asd doctor` drift 방지를 위해 V2 sync 시 정리.
- **Post-T2.1 재계획 게이트**: 코어 수정 대상이 5개 모듈(`acp-client.ts`, `policy.ts`, `drivers.ts`, `session-tracker.ts`, `transcripts.ts`)로 확인되어 Turn 4 코어 작업을 `T4.2`(`acp-client`, `policy`, `drivers`)와 `T4.3`(`session-tracker`, `transcripts`)로 분할 적용.

### 3.4 현재 아예 없는 것 (V2 이주 시 신규 개발)

1. OpenCode 버전 감지 (`opencode --version` 프로브)
2. V2 플러그인 API 구현 (정책 훅 + 완료 알림)
3. V2 설정 차이 대응 (`cli.json`, `commands`, V2 agent frontmatter)
4. V2 서버 API/ACP 호환 검증 및 필요 시 어댑터 수정
5. V2 네이티브 백그라운드 태스크와 ASD Dispatch의 역할 정리

---

## 4. 지원 정책

### 4.1 버전별 지원 수준

| 구분 | V2 | V1 |
|---|---|---|
| 신규 기능 | 지원 | 없음 |
| 버그 수정 | 지원 | 보안/치명 버그만 |
| 호환 수정 | 지원 | 공용 코드 변경으로 인한 깨짐만 |
| 훅/플러그인 | V2 API로 신규 구현 | 기존 `asd-guard.js` 동결 |
| 문서 | 최신 기준 | "Legacy" 표기 |
| 테스트 | 정식 매트릭스 | 스모크 테스트만 유지 |

### 4.2 제거 트리거

다음 중 먼저 도래하는 시점에 V1 경로를 제거한다.

1. OpenCode V1 공식 EOL 발표
2. 사용률 지표(주변 사용자/텔레메트리/이슈 문의) 기준 V1 비중 한 자릿수

제거 전 README와 이 문서에 최소 1개 마이너 릴리스 이상 사전 공지한다.

### 4.3 하지 말 것

- `8468491` 커밋 통째 revert/삭제: ACP 하이브리드 Dispatch, in-place idle resume, 공용 `--async`가 함께 사라진다.
- V1 플러그인 제거를 V2 정책 훅보다 먼저 수행: V2에서 정책 가드 공백이 발생한다.
- `--async`/`asd wait`를 "OpenCode 전용"으로 간주해 삭제: CLI·테스트·문서가 의존하는 공용 표면이다.

---

## 5. 단계별 이주 계획

### Phase 0: 검증 스파이크 (읽기 전용)

목표: 3.3의 "검증 필요" 항목을 실제 V1/V2 설치에서 확인해 지원 매트릭스를 확정한다.

| 작업 | 확인 내용 |
|---|---|
| 버전 프로브 | `opencode --version` 출력 형식(V1/V2), 종료 코드 |
| CLI 표면 | `run --format json`, `--pure`, `--model`, `--session`, `opencode models` |
| ACP 표면 | `opencode acp --pure` 동작 여부, V2 서버 API 차이 |
| 설정 표면 | `opencode.json/jsonc`, `command/` vs `commands/`, agent frontmatter |
| DB 표면 | `opencode.db` 스키마, storage JSON 폴백, `ses_` ID |
| 정책 표면 | V2 도구명(`write/edit/patch/bash` 등)과 이벤트명 |
| 플러그인 표면 | V2 플러그인 API 이벤트/클라이언트 메서드 |

**완료 기준**: 3.3 표의 "검증 필요"가 모두 `지원/미지원/대체 필요`로 갱신됨.

### Phase 1: 버전 감지 + capability 프로파일

목표: 단일 `"opencode"` 하네스 ID를 유지하면서 V1/V2 동작을 분기할 기반을 만든다.

- `detectOpenCodeVersion()` 추가 (`opencode --version` 파싱, 실패 시 `unknown`)
- capability 프로파일 정의: `{ version, pluginApi: "v1" | "v2" | "unknown", supportsAcp, supportsModelsCmd, ... }`
- installer가 프로파일에 따라 V1 플러그인 설치 여부를 결정
- 프로파일은 어댑터 경계 뒤에 두고, 공용 코드는 인터페이스만 참조

**완료 기준**: V1/V2 감지 테스트, 기존 다른 하네스 동작 무변경, 전체 테스트 통과.

### Phase 2: V2 훅/플러그인 어댑터

목표: V2에서 정책 가드와 완료 알림을 복구한다.

- V2 플러그인 API로 정책 훅(PreToolUse/Stop 상당) 구현
- V2 네이티브 백그라운드 태스크 사용 시 ASD `--async` 필요 여부 결정
  - V2가 셸 명령을 백그라운드로 돌리고 완료를 알린다면, ASD의 detached worker + 가드 콜백은 V2에서 선택 사항이 될 수 있음
  - `asd dispatch`를 blocking으로 호출하는 경우의 동작(타임아웃, 백그라운드 전환)을 명시
- 완료 알림 경로를 V2 API 기준으로 설계 (V1 `client.session.prompt` 대응물 확인)

**완료 기준**: V2에서 정책 가드 패리티 테스트 + async 완료 알림 테스트 통과.

### Phase 3: V1 격리·동결

목표: V1 전용 코드를 한 모듈에 가두고 공용 코드의 직접 참조를 제거한다.

- V1 전용 모듈 예: `src/adapters/opencode-v1/` 또는 단일 `opencode-v1.ts`
  - `asd-guard.js` 생성기, V1 세션 ID 배관, V1 스킬 문구
- 공용 코드는 capability 인터페이스만 참조 (V1 심볼 직접 import 금지)
- `openCodeSessionId`/`--opencode-session`/`notified` 필드는 V1 프로파일에서만 사용
- 공용 `--async`/`asd wait`는 유지
- 동결 규칙: V1 모듈에는 보안/치명 수정 외 변경 금지

**완료 기준**: `grep` 기준 V1 전용 심볼이 V1 모듈과 테스트 밖에서 발견되지 않음. V1 스모크 + V2 정식 테스트 통과.

### Phase 4: 문서·스킬 정비

목표: V1/V2 지침을 분리하고 지원 정책을 공지한다.

- 스킬 렌더러에 V1/V2 조건부 블록 추가
  - V2: 네이티브 백그라운드 기준 지침
  - V1: 기존 `--async` + `asd-guard.js` 지침 (Legacy 표기)
- README/README_ko/ACP_ROADMAP의 V1 서술을 Legacy 섹션으로 이동
- 지원 정책(4장)과 제거 트리거를 README에 링크

**완료 기준**: V2 사용자에게 V1 전용 지침이 노출되지 않음. 문서 링크/언어 스위처 정상.

### Phase 5: V1 제거 (EOL 트리거 도달 시)

- V1 모듈, 플래그, 필드, 문서, 테스트 제거
- installer의 V1 플러그인 설치/삭제 로직 정리
- 최소 마이너 버전 범프 (breaking change)
- `PATCH_NOTES.md`에 제거 공지

**완료 기준**: V2 단일 지원 테스트 매트릭스 통과. V1 관련 심볼/문서 잔존 없음.

---

## 6. 테스트 및 CI 정책

| 구분 | V2 | V1 |
|---|---|---|
| 단위/통합 | 전체 매트릭스 | 스모크만 |
| 정책 가드 | 필수 | 동결 (기존 테스트 유지) |
| async 완료 알림 | V2 방식 필수 | 기존 방식 유지 |
| 버전 감지 | 필수 | 필수 |
| 제거 시점 | - | V1 테스트 함께 삭제 |

---

## 7. 리스크 및 완화

| 리스크 | 영향 | 완화 |
|---|---|---|
| V2 정책 가드 공백 | V2에서 `.asd/` 보호·도구 차단 미작동 | Phase 2를 Phase 3보다 먼저 수행 |
| V2 플러그인 API 불안정 | 훅 구현 재작업 | Phase 0에서 검증, 버전 고정 + 기능 감지 |
| 동일 바이너리·설정 경로 | 잘못된 버전 분기 | 경로 가정 대신 런타임 버전 프로브 |
| V1 EOL 가정 오류 | 조기 제거로 사용자 이탈 | 트리거 도달 전까지 V1 모듈 유지 |
| `8468491` 과삭제 | ACP 하이브리드/공용 async 손실 | V1 콜백 계층만 분리, 공용 엔진 유지 |
| 스킬/문서 드리프트 | V2에 V1 지침 노출 | 렌더러 조건부 + 문서 테스트 |
| V2 서버 API 변경 | daemon-sse/abort 미동작 | Phase 0 검증, 실패 시 CLI 스트리밍 폴백 |

---

## 8. 확정 결정 사항 (사용자 확정 + Debate `D-mwqdzqsd-NGID` 반영)

1. **V1 제거 기준**: 고정 날짜 대신 공식 V1 EOL 또는 사용률 한 자릿수 도달 중 먼저 오는 시점 적용 (최소 1개 마이너 릴리스 전 사전 공지).
2. **V2 `--async` 및 완료 알림**: 공용 `--async`/`asd wait` 엔진 유지, V2는 네이티브 백그라운드 기본 안내 + V2 플러그인은 PreToolUse/Stop 정책 가드 우선 구현(완료 알림은 Phase 0에서 호환 V2 클라이언트 API 확인 시 선택 연결).
3. **V1 동결 기간 정책 훅**: V1 동결 기간에도 `asd-guard.js` 정책 훅 유지(보안/치명 수정만 허용).
4. **버전 감지 실패(`unknown`) 폴백**: V1(`effectiveProfile: "v1"`) 안전 폴백 적용 + `asd sync`/`asd doctor`에서 명시적 degraded 경고 출력(테스트/CI용 `ASD_OPENCODE_PROFILE=v1|v2` 오버라이드 지원).
5. **모듈 배치 및 코어 순수성(`HC-1`)**: `src/adapters/opencode.ts`를 V2 기본 정식 구현으로 유지(`opencode-v2.ts` 미생성), V2 구현 전 V1 전용 코드만 `src/adapters/opencode-v1.ts`로 선격리·동결, 순수 버전/capability 감지는 `src/core/opencode-profile.ts`에 배치(`src/core/*`의 `../adapters` import 금지 준수).

---

## 9. 부록: 근거 위치 요약

- V1 플러그인: `src/adapters/opencode.ts:90-366`, `src/adapters/installer.ts:1195-1197`, `:2078`, `:793`, `:2514`
- V1 세션 ID 배관: `src/core/types.ts:352-353`, `:381`, `src/cli/index.ts:166`, `:345-349`, `:2076`, `src/orchestrator/dispatch-handler.ts:845`
- V1 스킬/문서: `src/skills/asd-run/SKILL.md:51`, `src/skills/asd/SKILL.md:57`, `README.md:24,70-71,109,123-124`, `docs/ACP_ROADMAP.md:16,51-55`
- 공용 async: `src/orchestrator/dispatch-handler.ts:823-950`, `src/core/subagent-control.ts:800-880`, `src/cli/index.ts:272,1311,1427,2085-2100`
- 공용 어댑터 표면: 3.3 표 참조
