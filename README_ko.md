# Agent Swarm Director (`ASD` v2.7.0)

[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg)](./LICENSE)
[![Node.js: >=22.13.0](https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen.svg)](https://nodejs.org/)
[![Dependencies: 0 (Zero-Dep)](https://img.shields.io/badge/dependencies-0%20(zero--dep)-red.svg)](./package.json)
[![GitHub Stars](https://img.shields.io/badge/stars-agent--swarm--director-yellow.svg?logo=github)](https://github.com/N3wbie123/agent-swarm-director/stargazers)

[English](./README.md) | **한국어** | [🖥️ ASD-Nexus (공식 GUI)](https://github.com/N3wbie123/ASD-Nexus) | [⚡ ACP 로드맵](./docs/ACP_ROADMAP_ko.md) | [🧭 라우팅 가이드](./ROUTING_GUIDE_ko.md) | [🏛️ 아키텍처](./PROJECT_STATUS_ko.md) | [🔌 외부 SDK](./EXTERNAL_SDK_REFERENCE_ko.md) | [📋 패치 노트](./PATCH_NOTES_ko.md)

> **외부 런타임 의존성 0개(Zero-Dependency)로 Claude Code, OpenCode, Codex CLI, Antigravity, Cursor CLI 5대 AI 코딩 하네스를 통합 제어하는 범용 멀티 에이전트 오케스트레이션 하네스 및 SDK**

**Agent Swarm Director (`agent-swarm-director` / ASD v2.7.0)**는 5대 이기종 AI 코딩 하네스를 단일 컨트롤 플레인으로 묶어 주는 오케스트레이터입니다. 외부 npm 런타임 패키지를 단 하나도 쓰지 않고(`dependencies: {}`), 순수 Node.js(`>=22.13.0`) 네이티브 TypeScript 실행과 내장 `node:sqlite`(WAL 모드)만으로 **ACP(Agent Client Protocol) v1/v2 하이브리드 실행**, **Git 워크트리 격리 병렬 처리**, **교차 모델 적대적 토론**, **1ms Fail-Closed 보안 정책 게이트**를 제공합니다.

> [!TIP]
> **🖥️ 공식 데스크톱 / 웹 GUI — [ASD-Nexus](https://github.com/N3wbie123/ASD-Nexus)**  
> 5대 하네스의 로컬 세션을 한눈에 탐색하고, 대화 기록 4분류(*Thinking / Tool Use / Tool Result / 응답*) 열람, 실시간 스트리밍 대화, 클릭 한 번으로 CLI ↔ ASD 세션 승격·하강을 제어할 수 있습니다.

---

## 핵심 특징

- **외부 런타임 의존성 0개 (`dependencies: {}`)** — Node.js `>=22.13.0` 네이티브 TypeScript 실행과 `node:sqlite`만으로 구동되어 `asd update` 시 별도 패키지 설치가 필요 없고 훅 콜드스타트가 수 ms 이내입니다.
- **하이브리드 ACP 우선 서브에이전트 엔진 (v2.7.0)** — 순수 stdio JSON-RPC 2.0 기반 **ACP v1**(v2 초안 호환 포함)으로 서브에이전트를 자동 실행·종료하며, `session/request_permission` ↔ `policy.ts` 양방향 실시간 보안 판정, `session/new` 카탈로그 기반 모델 ID 자동 매핑(`resolveBestAcpModelId`), 일시적 멈춤 시 동일 워크트리 `session/load` 제자리 재개, 브리지 미설치 시 강화된 스트리밍 CLI 자동 폴백을 지원합니다.
- **OpenCode V2 정식 지원 및 공용 비동기 Dispatch (`--async`)** — OpenCode V2(`opencode v2.x`)와 동결된 레거시 V1(`1.x`)을 자동 감지하여 무의존성 V2 정책 가드(`~/.config/opencode/plugins/asd-guard/index.js`), 네이티브 `opencode acp` / `--auto` / `session_v2` 트랜스크립트와 V2 네이티브 백그라운드 실행을 지원하며, 모든 하네스에서 공용 `--async` + `asd wait`도 유지합니다 ([OpenCode V1/V2 지원 정책](./docs/OPENCODE_V1_V2_MIGRATION_PLAN_ko.md)).
- **3트랙 실행 체계 (`DIRECT` / `LIGHT` / `HEAVY`)** — 1~3개 파일의 순차 작업은 메인 세션에서 직접 처리(`DIRECT`)하고, 단일 하네스 내부 전문 위임은 파일 겹침 검증과 함께 수행(`LIGHT`), 대규모 병렬 작업은 격리된 Git 워크트리와 뮤텍스 직렬화 병합(`HEAVY`)으로 안전하게 동시 실행합니다.
- **블라인드 교차 모델 적대적 토론 (`asd debate`)** — 서로 다른 모델 패밀리(`claude`, `gpt`, `gemini`, `glm`, `deepseek`)가 코드 슬라이스·Diff를 바탕으로 1라운드 블라인드 비평 후 2라운드 심판 판결을 통해 필수 제약 조건을 도출합니다.
- **하네스 맞춤형 글로벌 동기화 (`asd sync`)** — 대상 하네스에 필요한 호출 구문과 `routing.jsonc` 모델 티어만 조건부 렌더링한 스킬, 5대 전문 에이전트(`planner`, `architect`, `worker`, `scout`, `critic`), 공식 CLI 안내를 포함한 `PreToolUse` 보안 훅, 부족한 외부 카탈로그 MCP 도구만 사용자 홈 설정에 깔끔하게 동기화합니다.
- **모듈형 CLI 오케스트레이터 및 계측 (`src/orchestrator/`)** — `asd plan|dispatch|verify|debate` 인프로세스 오케스트레이션, `asd plan schema`, 3-Strike 검증 에스컬레이션 힌트, 로그 포인터 기반 테스트 출력 요약, SQLite·`asd status`·`.asd/summary.md` 토큰/비용/재시도 계측, 경량 3트랙 궤적 평가(`npm run eval:trajectory`)를 제공합니다.
- **외부 GUI / TUI 연동 SDK** — 로컬 세션 통합 탐색(`discoverProjectCliSessions`), 대화 기록 4분류 파싱(`readHarnessTranscript`), 실시간 스트리밍 실행(`runDriverTurn`), 세션 승격·하강(`promoteCliSessionToAsd` / `demoteAsdSession`) API를 제공합니다.

---

## 5대 하네스 및 ACP 지원 현황

`asd doctor` 실행 시 약 **10ms** 만에 각 하네스의 CLI 설치 여부와 ACP 준비 상태를 점검합니다.

| 하네스 | 약칭 | CLI 실행 파일 | 기본 서브에이전트 통신 경로 | 선택적 ACP 브리지 설치 명령 |
| :--- | :---: | :--- | :--- | :--- |
| **OpenCode** | `@oc` | `opencode` | **네이티브 ACP** (V2: `opencode acp` / 레거시 V1: `--pure`) | 기본 내장 (추가 설치 불필요) |
| **Antigravity** | `@ag` | `agy` | **네이티브 ACP** (`agy acp`) | 기본 내장 (추가 설치 불필요) |
| **Cursor CLI** | `@cr` | `cursor-agent` / `agent` | **네이티브 ACP** (`cursor-agent acp`) | 기본 내장 (`.ps1` / `.cmd` 자동 해석) |
| **Claude Code** | `@cc` | `claude` | **ACP 브리지** → *미설치 시 스트리밍 CLI 폴백* | `npm i -g @agentclientprotocol/claude-agent-acp` |
| **Codex CLI** | `@cx` | `codex` | **ACP 브리지** → *미설치 시 스트리밍 CLI 폴백* | `npm i -g @agentclientprotocol/codex-acp` |

> Claude Code와 Codex는 브리지를 설치하지 않아도 스트리밍 CLI(`stream-json` / `--json --full-auto`)로 즉시 동작하며, 위 공식 브리지를 설치하면 별도 설정 없이 자동으로 ACP 모드로 전환됩니다.

---

## 빠른 시작 (Quick Start)

### 요구 사항
- **Node.js** `>=22.13.0`
- **Git** `>=2.30.0`

### 1. 최초 동기화 및 환경 진단
```bash
# 5대 하네스 글로벌 스킬·에이전트·훅 동기화 및 전역 PATH에 'asd' 등록
node --no-warnings src/cli/index.ts sync

# Node 버전, SQLite WAL, 하네스 CLI, ACP 준비 상태, 보안 훅 10ms 진단
asd doctor
```
*(전역 `PATH` 등록을 원치 않으면 `sync --no-path` 사용 후 `node --no-warnings <경로>/src/cli/index.ts <명령>`으로 실행할 수 있습니다.)*

### 2. 주요 CLI 사용 예시
```bash
asd status                                                # 실시간 TODO 진행 보드 및 세션 상태 확인
asd plan get                                              # 현재 .asd/PLAN.md 및 SQLite 태스크 조회
asd dispatch --turn 1 --mode parallel_spawn               # Turn 1 병렬 실행 (ACP 우선 + CLI 폴백)
asd dispatch --turn 1 --mode parallel_spawn --async       # 선택적 분리 백그라운드 실행 (레거시 OpenCode V1에서만 필수)
asd wait --timeout 600000                                 # 비동기 Wave 완료 시까지 대기 (수동 확인 시)
asd verify --task T1.1 --summary "ACP 모델 매핑 추가"     # 파일 경계·시크릿·테스트 검증 후 깔끔한 커밋 생성
asd debate --topic "스토리지 설계" --proposal "WAL 도입"  # 교차 모델 블라인드 비평 및 최종 판결
asd handoff                                               # 시크릿 마스킹된 세션 인수인계 문서(handoff.md) 생성
```

<details>
<summary><strong>📦 구버전(v2.3.2 이하) DB 마이그레이션 안내 (<code>asd migrate</code>)</strong></summary>

**ASD v2.3.3+**부터 기존 해시별 분산 DB(`~/.asd/state/<해시>/core.db`)가 단일 공유 WAL DB(`~/.asd/state/core.db`)로 통합되었습니다. 구버전 데이터는 자동 백업과 함께 아래 명령으로 안전하게 이관됩니다:

```bash
asd migrate
asd migrate --clean-legacy   # 선택: 이관 완료 후 구버전 core.db 정리
```
</details>

---

## 채팅창 내 AI 슬래시 스킬 (`/asd*`, `/handoff`)

`asd sync` 완료 후 **Claude Code**, **OpenCode**, **Codex CLI**, **Antigravity**, **Cursor CLI** 채팅창에서 바로 호출할 수 있습니다.

| 스킬 명령어 | 목적 | 작동 요약 |
| :--- | :--- | :--- |
| **`/asd <요청>`** | **전 과정 자율 수행** | `asd-scout` 탐색 → 사전 계획 브리핑 및 `LIGHT`/`HEAVY` 모드 확인 → `.asd/PLAN.md` 생성 → Wave별 실행·검증 → `.asd/summary.md` 작성 |
| **`/asd-plan <요청>`** | **계획 수립 전용** | 코드 수정 없이 읽기 전용 탐색 및 모호성 확인 후 `.asd/PLAN.md`와 SQLite 태스크 분해만 생성 |
| **`/asd-run`** | **계획 실행 및 재개** | `.asd/PLAN.md` 수동 편집분 역동기화(`asd plan sync_from_md`) 후 모드 확인을 거쳐 미완료 Turn 순차 실행 |
| **`/asd-debate <주제>`** | **적대적 설계 토론** | 이기종 모델 1라운드 블라인드 비평 + 2라운드 심판 판결(`APPROVE` / `MINOR_AMEND` / `REJECT`) 및 제약 조건 자동 반영 |
| **`/asd-debug <증상>`** | **재현 우선 디버깅** | 실패 재현 테스트 선작성 → 원인 진단 → 최소 수정 → `asd verify` 회귀 검증 및 커밋 |
| **`/handoff`** (`/asd-handoff`) | **세션 인수인계** | SQLite 진행 현황, Git 상태, 라우팅 정보, 대화 맥락을 묶어 다른 하네스에서 즉시 이어받을 수 있는 `handoff.md` 생성 |

### 실행 모드 비교 (`DIRECT` vs `LIGHT` vs `HEAVY`)

| 모드 | 서브에이전트 실행 방식 | 작업 공간 및 검증 동작 | 권장 상황 |
| :--- | :--- | :--- | :--- |
| **`DIRECT`** *(메인 세션)* | 메인 세션이 직접 수정 수행(`claim_only`), 대량 탐색 시에만 `asd-scout` 선택 호출. 서브에이전트 스폰 오버헤드 없음. | 인플레이스 수정 + `asd verify` 게이트(3-Strike 에스컬레이션 힌트) 및 깔끔한 커밋 생성. | 1~3개 파일 순차 수정, 빠른 패치, 컨텍스트 연속성이 중요한 작업 |
| **`LIGHT`** *(단일 하네스)* | 현재 하네스 내부의 네이티브 `asd-<role>` 서브에이전트 위임(`claim_only`). 동일 턴 다중 워커는 순차 실행 또는 `targetFiles` 완전 분리 검증. 외부 CLI 스폰 없음. | 인플레이스 수정. 테스트 실패 시 수정 파일을 보존해 즉시 디버깅 가능(경계·시크릿 위반 시 스코프 롤백). | 역할 분리 위임, 단일 하네스 쿼터 활용 |
| **`HEAVY`** *(다중 하네스)* | `routing.jsonc`에 따라 외부 하네스를 ACP / 스트리밍 CLI로 병렬 스폰(`parallel_spawn`; OpenCode V2는 네이티브 백그라운드 기본, 선택적 `--async` 지원). | 태스크별 독립 Git 워크트리(`.asd/wt/<turn>-<taskId>`) + `node_modules` 정션 연결 후 프로세스 뮤텍스 기반 `--no-ff` 병합. | 모듈 간 대규모 병렬 개발, 고위험 리팩터링, 교차 모델 검증 |

<details>
<summary><strong>🕰️ 레거시 OpenCode V1 지원 정책 (호환 모드 동결)</strong></summary>

OpenCode **V2(`2.x`)**가 정식 지원 대상(`plugins/asd-guard/index.js`, `opencode acp`, 네이티브 백그라운드)입니다. OpenCode **V1(`1.x`)**은 `src/adapters/opencode-v1.ts`에 격리·동결(보안/치명 버그만 수정)되어 `asd sync` 시 `plugin/asd-guard.js`와 레거시 V1 `--async` 스킬을 유지하며, `asd doctor`가 버전-플러그인 불일치(drift)를 점검합니다. V1 경로는 공식 V1 EOL 또는 V1 사용률 한 자릿수 도달 시 최소 1개 마이너 릴리스 사전 공지 후 제거됩니다. 자세한 내용은 **[OpenCode V1/V2 지원 전략 및 이주 계획](./docs/OPENCODE_V1_V2_MIGRATION_PLAN_ko.md)**을 참고하세요.
</details>

---

## CLI 명령어 레퍼런스

> `--no-path`로 동기화한 경우 `asd` 대신 `node --no-warnings src/cli/index.ts`를 사용합니다.

| 명령어 | 설명 |
| :--- | :--- |
| `asd sync [--force] [--refresh-models] [--no-model-probe] [--no-path]` | 5대 하네스 글로벌 스킬, 5개 핵심 에이전트, 보안 훅, MCP 카탈로그 및 `PATH` 실행 심 동기화 |
| `asd update` | Git 최신 릴리스 풀(`git pull --ff-only`) 후 새 프로세스로 글로벌 `asd sync` 자동 실행 |
| `asd doctor [--json]` | ~10ms 무토큰 환경 점검 (Node `>=22.13.0`, SQLite WAL, Git, 하네스 경로, ACP 준비 상태, 보안 훅 검증) |
| `asd plan [create\|get\|update\|sync_from_md\|schema] [--file <path>] [--track <DIRECT\|LIGHT\|HEAVY>]` | `.asd/PLAN.md`와 `~/.asd/state/core.db` 간 계획 생성·조회·수정·역동기화 및 공식 JSON 스키마 출력 |
| `asd dispatch [--turn <n>] [--mode <m>] [--async] [--transport <auto\|acp\|cli>]` | Wave 태스크 디스패치 (`--async` 지정 시 분리된 백그라운드 워커에서 논블로킹 실행) |
| `asd wait [--session <id>] [--timeout <ms>] [--json]` | 실행 중인 `asd dispatch --async` 백그라운드 Wave가 끝날 때까지 대기 후 결과 출력 |
| `asd verify --task <id> [--summary <text>] [--cmd <cmd>] [--file <path>]` | `allowedFiles` 경계·시크릿 검사 및 테스트(`300s` 기본 타임아웃) 통과 시 커밋 또는 워크트리 병합 |
| `asd debate --topic <t> --proposal <p> [--harnesses <csv>] [--diff]` | 이기종 모델 병렬 블라인드 비평 및 2라운드 심판 합의 도출 |
| `asd status [--json]` | 실시간 TODO `progressBoard`, 비동기 실행 상태, 미적용 자동 스태시 경고 출력 |
| `asd logs [taskId] [--json]` | 최근 또는 특정 태스크(`T1.1` 등)의 시크릿 마스킹된 서브에이전트 로그 조회 |
| `asd resume [--session <id>] [--print\|-p] [--json]` | 활성 ASD 세션을 하강시키고 원래 하네스의 대화형 CLI 재개 명령 실행(또는 출력) |
| `asd handoff [-o <path>] [--print\|-p] [--json]` | 시크릿 마스킹된 다중 하네스 인수인계 문서(`handoff.md`) 생성 |
| `asd clean [--pop] [--all] [--purge-orphans]` | 잔여 `.asd/wt/*` 워크트리·브랜치 정리, 자동 스태시 복원(`--pop`), 고아 세션 정리 |
| `asd migrate [--clean-legacy] [--json]` | 레거시 분산 `core.db`를 공유 `~/.asd/state/core.db`로 자동 백업 후 통합 |
| `asd ui [-p <port>]` | 경량 로컬 상태 대시보드 실행 (`http://127.0.0.1:3847`, 기능 동결 — 신규 UI는 **ASD-Nexus**에서 제공) |
| `asd uninstall [--home <dir>]` | ASD가 설치한 글로벌 훅·스킬·에이전트·심·관리형 MCP만 외과적으로 제거하고 사용자 설정 100% 복원 |

---

## 문서 가이드

- ⚡ **[ACP 아키텍처 및 추후 GUI 로드맵 (`docs/ACP_ROADMAP_ko.md`)](./docs/ACP_ROADMAP_ko.md)** — 무의존성 ACP v1/v2 구조, OpenCode V2 네이티브 ACP 및 레거시 V1 `--async` 완료 콜백, 브리지 안내, GUI(`runDriverTurn`) 체크리스트
- 🔄 **[OpenCode V1/V2 지원 정책 및 이주 계획 (`docs/OPENCODE_V1_V2_MIGRATION_PLAN_ko.md`)](./docs/OPENCODE_V1_V2_MIGRATION_PLAN_ko.md)** — V2 정식 지원 구조, 동결된 V1 격리 범위, EOL/사용률 기반 V1 제거 트리거
- 🧭 **[모델 라우팅 가이드 (`ROUTING_GUIDE_ko.md`)](./ROUTING_GUIDE_ko.md)** — `~/.asd/routing.jsonc`의 `lightSubagents`, `agents`, `categories`, 폴백 체인, `thinkingEffort` 설정법
- 🏛️ **[프로젝트 아키텍처 및 코드 레퍼런스 (`PROJECT_STATUS_ko.md`)](./PROJECT_STATUS_ko.md)** — 디렉토리 구조, 단일 SQLite DB 스키마, 모듈·함수별 상세 해설
- 🔌 **[외부 SDK, 하네스 저장소 및 DB 레퍼런스 (`EXTERNAL_SDK_REFERENCE_ko.md`)](./EXTERNAL_SDK_REFERENCE_ko.md)** — **ASD-Nexus** 등 외부 클라이언트 연동을 위한 Node.js SDK 계약, 단일 DB 명세 및 5대 하네스 실측 스트리밍·저장소 스펙
- 🤖 **[AI 에이전트 작업 프롬프트 (`AI_WORKFLOW_PROMPT_ko.md`)](./AI_WORKFLOW_PROMPT_ko.md)** — AI 코딩 에이전트 온보딩용 복사·붙여넣기 규칙 프롬프트
- 📋 **[패치 노트 (한국어)](./PATCH_NOTES_ko.md)** · **[Patch Notes (EN)](./PATCH_NOTES.md)** — `v2.7.0`까지의 전체 버전별 변경 이력

---

## 테스트 및 궤적 평가 실행

```bash
npm run typecheck
npm test
npm run eval:trajectory      # 결정론적 오프라인 3트랙 벤치마크 (DIRECT vs LIGHT vs HEAVY)
```

## 라이선스

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987
