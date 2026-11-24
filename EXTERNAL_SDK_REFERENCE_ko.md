# ASD v2.7.0 외부 SDK, 하네스 저장소 및 DB 통합 레퍼런스 (`EXTERNAL_SDK_REFERENCE_ko.md`)

> **버전**: `2.7.0` (단일 공유 DB `~/.asd/state/core.db` 기반 — 무의존성 ACP v1/v2 클라이언트, OpenCode V2 정식 지원 + 레거시 V1 동결 격리, 모듈형 `src/orchestrator/`, v2.6.0 SDK 정리, 토론 엔진 하드닝 반영 — `2.3.x` 이하와 DB 비호환)  
> **대상**: [**ASD-Nexus (`asd-gui`)**](https://github.com/N3wbie123/ASD-Nexus) 등 외부 애플리케이션 및 라이브러리 연동 개발자  
> **런타임 의존성**: `0개` (`dependencies: {}`, 순수 Node.js `>=22.13.0` 내장 모듈만 사용)  
> **메인 엔트리포인트**: [`src/index.ts`](./src/index.ts) (`import { ... } from "agent-swarm-director"`)

[English](./EXTERNAL_SDK_REFERENCE.md) | **한국어** | [📖 README (한국어)](./README_ko.md) | [🖥️ ASD-Nexus (공식 GUI)](https://github.com/N3wbie123/ASD-Nexus) | [⚡ ACP 로드맵](./docs/ACP_ROADMAP_ko.md) | [🏛️ 아키텍처](./PROJECT_STATUS_ko.md) | [🤖 AI 작업 프롬프트](./AI_WORKFLOW_PROMPT_ko.md) | [📋 패치 노트](./PATCH_NOTES_ko.md)

---

## 1. 단일 상태 DB 전환 및 v2.4.0 핵심 변경 사항

### 1.1 단일 공유 SQLite DB 전환 (`~/.asd/state/core.db`)
기존(v2.3.2 이하)에는 프로젝트마다 `~/.asd/state/<projectHash>/core.db`를 개별 생성했으나, 테스트 임시 프로젝트 누적 등으로 디렉토리가 수천 개로 늘어나는 문제를 해결하기 위해 **단일 공유 DB(`~/.asd/state/core.db`)** 구조로 전환했습니다.

> [!IMPORTANT]
> **구버전(`v2.3.2` 이하) DB 자동 복구·마이그레이션 도구 (`asd-db-migrate.mjs`)**:  
> 구버전(`v2.3.2` 이하)의 해시 디렉토리별 DB(`~/.asd/state/<projectHash>/core.db`) 데이터를 `v2.4.0` 단일 공유 DB(`~/.asd/state/core.db`)로 이관하거나 손상된 컬럼을 복구해야 하는 경우, 아래 공식 마이그레이션 툴을 다운로드해 실행하세요:  
> 👉 **[Google Drive에서 `asd-db-migrate` 다운로드](https://drive.google.com/drive/u/0/folders/1knUQzIY8HDzIKYkxrhsCxgorQDn_B3nU)** (`node asd-db-migrate.mjs`)

| 구분 | 이전 (v2.3.2 이하) | 현재 (v2.4.0) |
| :--- | :--- | :--- |
| **DB 파일 위치** | `~/.asd/state/<projectHash>/core.db` × N개 | **`~/.asd/state/core.db` 단 1개** |
| **프로젝트 구분 방식** | 해시 디렉토리 분리 | `sessions.project_root` 컬럼 스코프 (`SqliteDriver(dbPath, projectRoot?)`) |
| **프로젝트 목록 탐색** | 수천 개 디렉토리 순회 + DB N회 오픈 | `listKnownProjects()` 단일 쿼리 1회 + 15초 FS 캐시 (`skipDiskCheck` 지원) |
| **테스트 홈 격리** | 호출부마다 상이 | `ASD_HOME_DIR` 환경변수 단일 결정점 ([`resolveHomeDir`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/config.ts#L102-L108)) |

#### 외부 GUI(`asd-gui`) 연동 시 필수 확인 사항
1. **[`openProjectDb(projectRoot, homeDir?)`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L1030-L1040) 사용 권장**: 반환된 [`SqliteDriver`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/db.ts#L288-L1025) 인스턴스는 이미 해당 `projectRoot`로 스코프되어 있어 `listSessions()`, `getAllTasks()`, `getAllDebates()`, `getLatestSession()` 호출 시 자동으로 해당 프로젝트 데이터만 반환합니다.
2. **`new SqliteDriver(dbPath)` 직접 호출 주의**: 두 번째 인자(`projectRoot`)를 생략하면 전체 프로젝트의 세션이 함께 조회됩니다. 특정 프로젝트만 조회할 때는 반드시 `new SqliteDriver(dbPath, projectRoot)` 또는 `openProjectDb(projectRoot)`를 사용하세요.
3. **`projectHash` 용도**: `resolveAsdPaths()`와 `KnownProjectSummary`의 `projectHash`는 UI 리스트의 고유 키(`key={p.projectHash}`)로 계속 사용할 수 있으나, 실제 DB 경로는 항상 `paths.dbPath`(`~/.asd/state/core.db`)를 참조해야 합니다.

### 1.2 v2.4.0 신규 및 고도화 SDK 요약
1. **프로젝트별 5대 하네스 CLI 세션 통합 탐색 ([`discoverProjectCliSessions`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1774-L1895))**:
   - Claude Code, OpenCode, Codex, Antigravity, Cursor에서 현재 프로젝트 경로로 실행된 모든 CLI 세션을 찾고, ASD 세션 승격 여부(`isPromotedToAsd`, `asdSessionId`, `asdPhase`)까지 결합해 반환합니다.
2. **대화 기록 4분류 정밀 파싱 ([`readHarnessTranscript`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L995-L1084))**:
   - 각 하네스의 로컬 DB/파일에서 대화 기록을 읽어 **① Thinking(`thinking`), ② Tool Use(`tool_use`), ③ Tool Result(`tool_result`), ④ 사용자에게 답하는 메시지(`assistant`) 및 사용자 메시지(`user`)**로 정밀 분리합니다.
3. **실시간 스트리밍 턴 실행 ([`runDriverTurn`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L926-L1196) & [`parseDriverStreamLine`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L583-L920))**:
   - 유저 메시지를 실제 하네스로 전달해 실행하면서, 실행 도중 발생하는 실시간 Thinking 과정, Tool Use 과정, Tool Result, 응답 텍스트를 `onEvent` 콜백으로 즉시 스트리밍합니다.
4. **일반 CLI 세션 ↔ ASD 세션 양방향 승격 및 하강**:
   - **승격(Promote)**: [`promoteCliSessionToAsd`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1619-L1740)로 일반 CLI 세션을 ASD 세션으로 즉시 승격(멱등성 보장 + 드라이버 자동 연결)합니다.
   - **하강(Demote)**: [`demoteAsdSession`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1455-L1545)(또는 CLI `asd resume`)로 ASD 세션을 일시정지하고 원래 하네스의 네이티브 CLI 세션으로 즉시 복귀합니다.
5. **초기 로딩 및 모델 탐색 속도 최적화**:
   - [`discoverHarnessModels`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L225-L470): 비동기 병렬 실행(`Promise.all`) + `~/.asd/state/models-cache.json`(10분 TTL) 디스크 캐시 적용.
   - [`listKnownProjects`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1901-L1980): 15초 인메모리 FS 캐시, `skipDiskCheck`, `db` 인스턴스 재사용 옵션 추가.

---

## 2. v2.4.0 핵심 신규/개선 SDK 상세 사용법

### 2.1 프로젝트 내 5대 하네스 CLI 세션 통합 탐색 (`discoverProjectCliSessions`)

특정 프로젝트 경로에서 실행된 5대 하네스의 로컬 CLI 세션을 모두 스캔(`syncLocalHarnessTranscripts` 포함)하고 `core.db`의 ASD 세션과 매칭하여 최신순으로 반환합니다.

```ts
import {
  discoverProjectCliSessions,
  type DiscoveredCliSession,
  type DiscoverProjectCliSessionsOptions,
} from "agent-swarm-director";

const sessions: DiscoveredCliSession[] = discoverProjectCliSessions("/path/to/project", {
  limit: 100,
  syncLocalTranscripts: true, // 기본값 true: Claude/Codex/OpenCode/Antigravity 로컬 스토리지 스캔 포함
});
```

#### `DiscoveredCliSession` 반환 구조
| 필드 | 타입 | 설명 |
| :--- | :--- | :--- |
| `harness` | `HarnessId` | `"claude-code" \| "opencode" \| "codex" \| "antigravity" \| "cursor"` |
| `harnessSessionId` | `string` | 하네스 네이티브 세션 ID (UUID 등) |
| `projectRoot` | `string` | 정규화된 프로젝트 루트 경로 |
| `updatedAt` | `number` | 마지막 활동 시각 (Unix epoch ms) |
| `model` | `string \| undefined` | 감지된 모델 ID |
| `summary` | `string \| undefined` | 세션의 첫 사용자 프롬프트 또는 요약 제목 |
| `transcriptPath` | `string \| undefined` | 로컬 트랜스크립트 파일(`.jsonl`) 또는 `opencode.db` 경로 |
| `asdSessionId` | `string \| null` | 승격된 ASD `session_id` (미승격 일반 CLI 세션이면 `null`) |
| `asdPhase` | `SessionPhase \| null` | `"planning" \| "running" \| "paused" \| "done" \| null` |
| `isPromotedToAsd` | `boolean` | ASD 세션으로 승격되어 `core.db`에 등록되어 있으면 `true` |

---

### 2.2 대화 기록 4분류 파서 (`readHarnessTranscript`)

각 하네스의 로컬 트랜스크립트에서 대화 기록을 읽어 **Thinking**, **Tool Use**, **Tool Result**, **User / Assistant 메시지**로 분류합니다.
- **Claude Code**: `~/.claude/projects/<encoded>/*.jsonl`의 `thinking`, `tool_use`, `tool_result`, `text` 블록 분리.
- **Codex CLI**: `~/.codex/sessions/**/<id>.jsonl`의 `agent_reasoning`, `function_call`, `custom_tool_call`, `function_call_output`, `user_message`, `agent_message` 분리.
- **OpenCode**: `~/.local/share/opencode/opencode.db`의 `part` 테이블(`reasoning`, `tool`, `text`) 및 JSON 스토리지 분리.
- **Antigravity**: `transcript.jsonl`의 `USER_INPUT`, `PLANNER_RESPONSE`(`thinking`, `tool_calls`), `TOOL_RESPONSE` 분리 및 `truncated_fields` 발생 시 `transcript_full.jsonl` 해당 라인 자동 복원.

```ts
import {
  readHarnessTranscript,
  type TranscriptReadResult,
  type TranscriptMessage,
  type TranscriptMessageCategory,
} from "agent-swarm-director";

const transcript: TranscriptReadResult = readHarnessTranscript({
  harness: "claude-code", // "claude-code" | "opencode" | "codex" | "antigravity" | "cursor"
  projectRoot: "/path/to/project",
  harnessSessionId: "eb7de063-fd75-4fa7-8312-9efcf3fd77e5",
  transcriptPath: undefined, // 선택: 알고 있는 경우 직접 전달하면 디스크 탐색 생략
  maxMessages: 300,
});
```

#### `TranscriptMessage` 인터페이스 (v2.4.0)
```ts
export type TranscriptMessageCategory =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system";

export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "tool";
  category?: TranscriptMessageCategory;
  text: string;
  thinking?: string; // category === "thinking" 일 때 추론 원문
  toolName?: string;
  toolUse?: {
    name: string;
    id?: string;
    input?: string;  // 도구 호출 인자 JSON 문자열
  };
  toolResult?: {
    name?: string;
    toolUseId?: string;
    output: string;  // 도구 실행 결과 텍스트
    isError?: boolean;
  };
  timestamp?: string;
}
```

---

### 2.3 실시간 스트리밍 대화 실행 (`runDriverTurn`, `parseDriverStreamLine`)

유저가 대화창을 통해 보낸 메시지를 실제 하네스로 전달해 실행하고, 실행 중 발생하는 **Thinking 과정**, **Tool Use 과정**, **Tool Result**, **응답 텍스트**를 `onEvent` 콜백으로 실시간 수신합니다.

```ts
import {
  openProjectDb,
  runDriverTurn,
  cancelDriverTurn,
  closeDriverSession,
  closeAllDriverSessions,
  type DriverStreamEvent,
  type DriverRunResult,
} from "agent-swarm-director";

const db = openProjectDb("/path/to/project");
const controller = new AbortController();

const result: DriverRunResult = await runDriverTurn({
  projectRoot: "/path/to/project",
  db,
  sessionId: "asd-20261103-182153-i9ti",
  prompt: "현재 프로젝트의 세션 트래커 구조를 분석해줘.",
  model: "claude-sonnet-4-6",   // 선택: driver.model / 기본 모델 오버라이드 (ACP 세션에서는 setSessionModel로 전환)
  transport: "auto",            // "auto" (기본: ACP 우선, 실패 시 CLI 폴백) | "acp" | "cli"
  autoApprove: false,           // false 시 onPermissionRequest 콜백으로 대화형 권한 확인 (생략 시 session.auto_approve 따름)
  onPermissionRequest: async (params) => {
    const allowOpt = params.options?.find((o) => o.kind === "allow_once");
    return allowOpt
      ? { outcome: { outcome: "selected", optionId: allowOpt.optionId } }
      : { outcome: { outcome: "cancelled" } };
  },
  signal: controller.signal,    // AbortSignal로 협조적 취소(ACP session/cancel) 트리거 가능
  streamJson: true,             // CLI 경로 사용 시 NDJSON 스트리밍 활성화
  onEvent: (event: DriverStreamEvent) => {
    switch (event.type) {
      case "thinking":
        console.log("[실시간 Thinking]", event.thinking);
        break;
      case "tool_use":
        console.log("[실시간 Tool Use]", event.toolName, event.toolInput);
        break;
      case "tool_result":
        console.log("[실시간 Tool Result]", event.toolOutput);
        break;
      case "text":
        console.log("[실시간 Assistant 응답]", event.text);
        break;
    }
  },
});

// 상주형 ACP 턴 제어 및 세션 풀 정리 헬퍼
cancelDriverTurn("asd-20261103-182153-i9ti"); // 실행 중인 ACP 턴에 session/cancel 전송
await closeDriverSession("asd-20261103-182153-i9ti"); // 해당 세션의 상주 ACP 클라이언트 종료
await closeAllDriverSessions(); // 전체 상주 ACP 세션 풀 일괄 종료
```

#### `RunDriverTurnInput` 주요 ACP·권한·수명주기 옵션
| 옵션 / 헬퍼 | 타입 / 시그니처 | 설명 |
| :--- | :--- | :--- |
| `transport` | `"auto" \| "acp" \| "cli"` | `"auto"`(기본, `commandRunner` 지정 시 `"cli"`): 상주 ACP 세션 우선 실행 및 Phase-A 실패 시 CLI 폴백. `"acp"`는 ACP 미지원/실패 시 오류 발생 |
| `model` | `string \| null` | 턴 실행 시 사용할 모델 오버라이드 (상주 ACP 풀 재사용 시 `setSessionModel`로 전환) |
| `autoApprove` | `boolean` | `true`면 ACP 권한 요청을 자동 승인, `false`면 `onPermissionRequest` 위임 (보호 경로는 코어 가드가 선차단) |
| `onPermissionRequest` | `(params: AcpRequestPermissionParams) => Promise<AcpRequestPermissionResult>` | `autoApprove: false`일 때 `session/request_permission` 응답을 비동기로 반환하는 콜백 |
| `cancelDriverTurn` | `(sessionId: string) => boolean` | 해당 세션에서 실행 중인 ACP 턴에 `session/cancel` 전송 (`signal?: AbortSignal`과 동일 효과) |
| `closeDriverSession` | `(sessionId: string) => Promise<void>` | 특정 세션에 연결된 상주 ACP 클라이언트만 풀에서 제거하고 종료 |
| `closeAllDriverSessions` | `() => Promise<void>` | 앱 종료 시 모든 상주 ACP 클라이언트를 정리 |

---

### 2.4 ASD 세션 관리: 승격 (`promoteCliSessionToAsd`) 및 하강 (`demoteAsdSession`)

#### ① 일반 CLI 세션을 ASD 세션으로 승격 (Promote)
```ts
import {
  promoteCliSessionToAsd,
  type PromoteCliSessionResult,
} from "agent-swarm-director";

const promoted: PromoteCliSessionResult = promoteCliSessionToAsd({
  projectRoot: "/path/to/project",
  homeDir: undefined,        // 선택: 생략 시 resolveHomeDir() 적용
  harness: "claude-code",
  harnessSessionId: "eb7de063-fd75-4fa7-8312-9efcf3fd77e5",
  model: "claude-sonnet-4-6",
  title: "GUI에서 승격된 세션",
  memo: "GUI에서 승격된 세션",
  transcriptPath: undefined, // 선택: 로컬 트랜스크립트 경로
  makeForeground: true,      // true 시 .asd/PLAN.md 의 전경(Foreground) 세션으로 즉시 설정
  source: "gui",             // "gui" | "cli" (기본값 "gui")
  db: undefined,             // 선택: 이미 열린 SqliteDriver 인스턴스 주입 가능
});
// promoted.sessionId / promoted.asdSessionId -> 승격된 ASD session_id (동일 값)
// promoted.created                           -> 신규 생성 여부 (이미 승격된 세션이면 false, 기존 세션 재사용)
// promoted.driver                            -> 부착된 활성 DriverRow
// promoted.session                           -> 생성 또는 재사용된 SessionRow
```

#### ② ASD 세션을 다시 하네스의 네이티브 CLI 세션으로 하강 및 연결 해제 (`buildSessionDemotion`, `unlinkHarnessSessionFromAsdSession`)
```ts
import {
  buildSessionDemotion,
  unlinkHarnessSessionFromAsdSession,
  type SessionDemotionResult,
} from "agent-swarm-director";

// 1. 터미널 대화형 Resume 명령어 생성 (asd resume 과 동일; 활성 드라이버가 없어도 session.harness_session_id 폴백 지원)
const demoted: SessionDemotionResult = buildSessionDemotion({
  projectRoot: "/path/to/project",
  sessionId: "asd-20261103-182153-i9ti",
});
// demoted.cliString -> 'claude --resume "eb7de063-fd75-4fa7-8312-9efcf3fd77e5"'

// 2. ASD 세션에서 드라이버 연결을 끊고 cli-recent.json 의 asdSessionId 를 null 로 초기화하여 일반 CLI 세션으로 복원
const unlinked = unlinkHarnessSessionFromAsdSession({
  projectRoot: "/path/to/project",
  asdSessionId: "asd-20261103-182153-i9ti",
  deleteAsdSession: false, // true 전달 시 core.db 에서 해당 ASD 세션과 하위 태스크/드라이버를 연쇄 삭제
});
```

---

### 2.5 고속 프로젝트 로딩 및 모델 캐시 API (`listKnownProjects`, `discoverHarnessModels`)

```ts
import {
  listKnownProjects,
  discoverHarnessModels,
  getModelsDiskCachePath,
} from "agent-swarm-director";

// 1. 프로젝트 목록 고속 조회 (15초 FS stat 캐시 적용; skipDiskCheck: true 시 디스크 I/O 없이 DB만 즉시 조회)
const projects = listKnownProjects({
  skipDiskCheck: false,
  forceRefresh: false,
});

// 2. 비동기 병렬 모델 조회 (~/.asd/state/models-cache.json 10분 디스크 캐시 사용)
const models = await discoverHarnessModels(false); // 강제 새로고침 시 true
const cachePath = getModelsDiskCachePath();
```

---

## 3. 전체 외부 호출 가능 인터페이스 카탈로그

### 3.1 Node.js 라이브러리 서브패스 Export (`package.json` `exports`)

```ts
import * as asd from "agent-swarm-director";                       // 전체 코어 통합 엔트리 (src/index.ts)
import * as db from "agent-swarm-director/core/db";                // 개별 코어 서브모듈 직접 import
import * as orch from "agent-swarm-director/orchestrator/index";   // 모듈형 CLI 오케스트레이터
import * as dashboard from "agent-swarm-director/cli/dashboard";   // 로컬 `asd ui` 서버 (서브패스 전용)
```

| 모듈 경로 | 대표 공개 함수 및 클래스 |
| :--- | :--- |
| **`core/types`** | `ASD_VERSION` (`"2.7.0"` — `package.json`에서 런타임 파생), `HARNESS_IDS`, `AGENT_ROLES`, `TASK_CATEGORIES`, `DIFFICULTY_TIERS`, `TASK_TRACKS` (`"DIRECT" \| "LIGHT" \| "HEAVY"`), `TASK_STATUSES`, `SESSION_PHASES`, `DRIVER_SOURCES` 및 전체 타입 |
| **`core/acp-types` & `core/acp-client`** *(v2.7.0)* | 무의존성 ACP v1/v2 JSON-RPC stdio 클라이언트: `AcpStdioClient`, `probeAcpCapability`, `executeAcpSubagentTurn`, `resolveBestAcpModelId`, `checkInteractivePermissionSafety` |
| **`core/config`** | `resolveAsdPaths(root, home?)`, `resolveHomeDir(explicit?)`, `ensureProjectInitialized`, `loadRoutingConfig`, `loadMcpCatalog`, `checkForRemoteUpdate`, `computeProjectHash` |
| **`core/opencode-profile`** *(v2.7.0)* | `detectOpenCodeProfile` — OpenCode V2(`2.x`, 정식 지원) vs 레거시 V1(`1.x`, 동결) 프로파일 자동 감지 |
| **`core/db`** | `openProjectDb(root, home?)`, `SqliteDriver(dbPath, projectRoot?)`, `generateAsdSessionId`, `isValidAsdSessionId` — `findSessionByHarnessSessionId`, `deleteSession`, `injectDebateAcceptance` 및 `sessions` / `tasks` / `debates` / `session_drivers` 전체 CRUD |
| **`core/session-tracker`** | `discoverProjectCliSessions`, `promoteCliSessionToAsd`, `unlinkHarnessSessionFromAsdSession`, `buildSessionDemotion`, `listKnownProjects`, `syncLocalHarnessTranscripts`, `linkHarnessSessionToAsdSession`, `readCliRecentSessions`, `recordCliRecentSession`, `buildSpawnSpec`, `buildHeadlessHarnessCommand`, `buildResumeHarnessCommand` *(v2.6.0부터 options 객체 형태 전용)*, `buildInteractiveResumeHarnessCommand`, `extractHookSessionInfo` |
| **`core/drivers`** | `runDriverTurn` *(상주 ACP 세션 풀 + 네이티브 JSONL CLI 폴백)*, `cancelDriverTurn`, `closeDriverSession`, `closeAllDriverSessions`, `parseDriverStreamLine`, `attachDriver`, `detachDriver`, `getActiveDriver`, `listDrivers`, `buildDriverBriefing`, `syncSessionDriversToMainJson` |
| **`core/transcripts`** | `readHarnessTranscript` *(Claude, OpenCode V1/V2 `session_v2`, Codex `.jsonl`/`.jsonl.zst`, Antigravity, Cursor lossy 폴백 4분류 파서)*, `locateHarnessTranscript` |
| **`core/spawner`** | `spawnSubagent`, `executeHarnessProcess`, `killProcessTree`, `resolveSpawnCommand`, `finalizeSubagentArtifacts` |
| **`core/router`** | `resolveRoute`, `runWithFallbacks` *(optional `maxRetries` 상한)*, `escalateTaskRoute`, `resolveFallback`, `detectAvailableCliHarnesses`, `detectLiveRuntimeCapabilities`, `selectDiverseReviewer` *(optional 누적 `excludedFamilies`)*, `resolveLightSubagentRoute`, `saveProjectRoutingConfig` |
| **`core/models`** | `discoverHarnessModels`, `getModelsDiskCachePath` |
| **`core/session-services`** | `saveSessionMemo`, `collectDashboardSnapshot` |
| **`core/subagent-control`** | `runSubagentControlAction` |
| **`core/subagent-logs`** | `scanSubagentLogs`, `SubagentLogRecord` |
| **`core/workspace`** | `prepareBaseline`, `createTaskWorktree`, `verifyAndCommitLightTask`, `verifyAndMergeHeavyTask`, `approvePendingTask`, `rejectPendingTask`, `rollbackLightChanges`, `recoverOrphanedTasks`, `isPidAlive`, `verifyPidIdentity`, `getChangedFiles`, `checkChangedFilesAndSecrets`, `withMergeLock`, `runGit` |
| **`core/render`** | `renderPlanMd`, `parsePlanMd`, `syncPlanFromMd`, `setForegroundSession`, `getForegroundSessionId`, `renderProgressBoard`, `renderSessionSummaryMd`, `atomicWriteFileSync` |
| **`core/debate`** | `runDebateBroker` *(하이브리드 ACP + 스트리밍 CLI, `REJECT` DB/PLAN 오염 차단, Arbiter 단독 권위, 사후 `diversityDegraded` 재산출)*, `parseReviewerOpening`, `synthesizeInsightVerdict`, `buildDebateCodeContext`, `buildRound2CitedCodeContext`, `buildRound1Prompt` *(optional `role`)*, `buildRound2Prompt`, `formatDebateAcceptance` |
| **`core/policy`** | `evaluatePreToolUse`, `evaluateStopHook`, `resolveSafeTargetPath`, `isPathAllowed`, `checkProtectedPath`, `verifyChangedFilesBoundary` |
| **`core/redact` & `jsonc`** | `redactSecrets`, `containsSecrets`, `parseJsonc`, `stripJsoncComments`, `upsertTomlFencedBlock`, `removeTomlFencedBlock` |
| **`adapters/*`** | `ClaudeCodeAdapter`, `OpenCodeAdapter` (V2 기본 + 동결 `opencode-v1.ts`), `CodexAdapter`, `AntigravityAdapter`, `CursorAdapter`, `syncHarnessConfigs`, `uninstallGlobalConfigs`, `runAsdDoctor`, `createHarnessProvisionerPlugin`, `createHarnessRuntimePlugin`, `registerDefaultHarnessPlugins` |
| **`orchestrator/*`** *(v2.7.0)* | `AsdOrchestrator`, `PLAN_SCHEMA_DEFINITION`, `handlePlan`, `handleDispatch`, `handleVerify`, `handleDebate`, `buildEscalationHint`, `detectRoleCategoryWarnings`, `findOverlappingLightTargetFiles`, `parseSubagentReport` |
| **`cli/dashboard`** | `startDashboardServer` *(서브패스 `agent-swarm-director/cli/dashboard` 전용 — `asd ui` 서버+UI, 기능 동결)* |
| **`cli/index`** | `getAdapter`, `getLatestSession`, `runAsdLogs`, `runAsdClean` |

---

### 3.2 CLI 서브커맨드 (`asd <command>`)

공통 플래그: `--json`, `--project-root <dir>`, `--home <dir>`, `--session <id>`, `--harness <id>`.

| 명령어 | 설명 | 주요 플래그 |
| :--- | :--- | :--- |
| `asd plan [create\|get\|update\|sync_from_md\|schema]` | `.asd/PLAN.md` 및 SQLite 태스크 생성·조회·수정·역동기화 및 공식 JSON 스키마 출력 | `--tasks <json>`, `--payload <json\|->`, `--file <path>`, `--track <DIRECT\|LIGHT\|HEAVY>` |
| `asd dispatch` | Turn(Wave) 태스크 병렬 실행 또는 클레임 (ACP 우선 + CLI 폴백) | `--turn <n>`, `--mode parallel_spawn\|claim_only`, `--async`, `--transport <auto\|acp\|cli>`, `--task T1.1` |
| `asd wait` | 실행 중인 `asd dispatch --async` Wave 완료까지 대기 | `--session <id>`, `--timeout <ms>`, `--json` |
| `asd verify --task <id>` | 파일 경계·시크릿·테스트 검증 후 커밋(`DIRECT`/`LIGHT`) 또는 워크트리 병합(`HEAVY`) | `--summary`, `--files`, `--cmd`, `--file <path>` |
| `asd debate --topic <t> --proposal <p>` | 교차 모델 블라인드 적대적 토론 및 비-`REJECT` 제약 `acceptance` 자동 주입 | `--proposal-file`, `--task` / `--task-id`, `--harnesses`, `--roles`, `--count`, `--diff`, `--files path:start-end` |
| `asd resume` | 활성 ASD 세션을 하강(`demote`)하고 원래 하네스의 대화형 CLI로 즉시 복귀 | `--session <id>`, `--print`, `--json` |
| `asd status` | 현재 프로젝트의 전경 세션 진행 현황 보드(`progressBoard`, 영문 기본) 출력 | `--json` |
| `asd logs [taskId]` | 최근 또는 특정 태스크의 서브에이전트 프롬프트·출력 로그 조회 | `--json` |
| `asd ui` | 로컬 실시간 웹 대시보드 서버 실행 (기본 포트 `3847`, 기능 동결) | `--port <num>`, `--no-open` |
| `asd sync` | 5대 하네스 글로벌 스킬·에이전트·훅·외부 MCP 카탈로그 동기화 및 전역 `PATH` 등록 | `--force`, `--refresh-models`, `--no-model-probe`, `--no-path` |
| `asd update` | GitHub 최신 버전 pull 및 `asd sync` 자동 실행 | — |
| `asd doctor` | ~10ms 환경·하네스·ACP 준비 상태·보안 훅 헬스체크 | `--json` |
| `asd migrate` | 구버전 분산 `core.db`(`<= v2.3.2`)를 `~/.asd/state/core.db`로 통합 이관 | `--clean-legacy`, `--json` |
| `asd clean` | 잔여 `.asd/wt/*` 워크트리 정리, auto-stash 복원, 고아 세션 정리 | `--pop`, `--all`, `--purge-orphans` |
| `asd uninstall` | ASD가 설치한 글로벌 설정만 외과적으로 원복 | `--home <dir>` |
| `asd hook <type>` | 하네스 훅 평가기 (`session-start`, `pre-invocation`, `pre-tool-use`, `stop`) | stdin JSON → stdout JSON |

---

### 3.3 로컬 웹 대시보드 HTTP API (`asd ui`, 기본 `http://127.0.0.1:3847`)

| 엔드포인트 | 메서드 | 설명 |
| :--- | :--- | :--- |
| `/api/state` | `GET` | `collectDashboardSnapshot()` 전체 상태 스냅샷 반환 |
| `/api/models` | `GET` | 5대 하네스별 사용 가능 모델 목록 조회 (`models-cache.json` 활용) |
| `/api/models/refresh` | `POST` | 모델 목록 강제 재탐색 (`discoverHarnessModels(true)`) |
| `/api/session-memo` | `POST` | 세션 한 줄 메모 저장 (`{ sessionId, memo }`) |
| `/api/routing` | `POST` | 프로젝트 로컬 라우팅(`.asd/routing.jsonc`) 저장 또는 초기화 (`{ action: "save" \| "reset", routingConfig }`) |
| `/api/subagent-action` | `POST` | 서브에이전트 실시간 제어 (`{ sessionId, subSessionId, action: "kill" \| "retry" \| "fallback" \| "custom", harness?, model? }`) |

---

## 4. 5대 하네스 저장소, 스트리밍 스키마 및 운영 주의사항

5대 하네스는 모두 동일한 3단계 SDK 파이프라인(`discoverProjectCliSessions` → `readHarnessTranscript` → `runDriverTurn` + `parseDriverStreamLine`)으로 추상화되며, 통일된 `DriverStreamEvent`(`thinking` / `tool_use` / `tool_result` / `text` / `raw`)를 방출합니다. 클라이언트 앱은 하네스별 분기나 CLI 플래그 직접 조립 대신 SDK 정규화 이벤트를 소비해야 합니다.

### 4.1 하네스별 실측 통합 매트릭스

| 하네스 | 로컬 세션 저장소 | 기본 통신 / 스트리밍 경로 | 실측 이벤트 흐름 및 주요 주의사항 |
| :--- | :--- | :--- | :--- |
| **Claude Code (`@cc`)** | `~/.claude/projects/<cwd-인코딩>/<uuid>.jsonl` *(포맷 변동 가능 — 반드시 `readHarnessTranscript` 경유)* | ACP 브리지(`@agentclientprotocol/claude-agent-acp`) 또는 CLI `claude -p ... --output-format stream-json --verbose --include-partial-messages` | `system/init` → `stream_event`(`content_block_delta`: `text_delta`/`thinking_delta`/`input_json_delta`) → `assistant` → `user`(`tool_result`) → `result`. 긴 프롬프트는 `stdin` 전달; JSONL 스키마 드리프트 방어 내장. |
| **OpenCode (`@oc`)** | `~/.local/share/opencode/opencode.db` (SQLite WAL — V2: `session_v2`/`session_message`/`session_part`, 동결 V1: `session`/`message`/`part`). 경로 확인: `opencode debug paths db`. | **네이티브 ACP** (V2: `opencode acp`, 레거시 V1: `--pure`) 또는 CLI `opencode run ... --format json` (V2 `--auto` 지원) | 파트 완료 단위 이벤트(`step_start` → `text` → `step_finish`) 또는 ACP `session/update` 델타. 수 GB DB 전체 스캔 금지(세션 ID 스코프 쿼리만); 세션 ID는 항상 `ses_` 접두사(Claude 훅 미러 오표기 자가 치유 내장). |
| **Codex CLI (`@cx`)** | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (구세션 `.jsonl.zst`는 `node:zlib` / `zstd`로 자동 투명 복원) | ACP 브리지(`@agentclientprotocol/codex-acp`) 또는 CLI `codex exec ... --json` | `thread.started` → `turn.started` → `item.started\|completed`(`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`) → `turn.completed`. 파이프 환경에서 **반드시 `stdin`을 닫아야** 대기 멈춤 방지. |
| **Antigravity (`@ag`)** | `~/.gemini/antigravity-cli/conversations/<id>.db` + `brain/<id>/.system_generated/logs/transcript.jsonl` (`truncated_fields` 시 `transcript_full.jsonl` 자동 복원) | **네이티브 ACP** (`agy acp`) 또는 CLI `agy -p ... --output-format stream-json` | `init` → `step_update`(`text_delta`, ~25ms 토큰 델타) → `result`(`result.response`). 누적 델타와 `result.response` 중복 제거 필요(ASD 내장). 재개는 `--conversation <id>` 사용. |
| **Cursor CLI (`@cr`)** | `~/.cursor/chats/<workspace-md5>/<chat-uuid>/store.db` *(비공개 blob — 네이티브는 `unsupported` 반환, `~/.asd/transcripts/cursor/<id>.jsonl` lossy 스트림 폴백 지원)* | **네이티브 ACP** (`cursor-agent acp`) 또는 CLI `cursor-agent -p ... --force --output-format stream-json` | `system/init` → **`user` 프롬프트 에코(자동 스킵)** → `thinking`(`subtype: "delta"`) → `tool_call`(`started\|completed`, `tool_call.<family>ToolCall.result.success\|error.errorMessage`) → `assistant` → `result`. Windows `.ps1` 래퍼는 `powershell -File` / `.cmd` 심으로 자동 스폰. |

### 4.2 코어–클라이언트 경계 원칙
- **클라이언트 앱에서 하네스 CLI 플래그 직접 조립 금지** — `runDriverTurn` / `buildSpawnSpec`에 위임.
- **`.asd/` 디렉토리 직접 파일 수정 금지** — 공식 SDK / `asd` CLI(`openProjectDb`, `asd plan`, `asd verify` 등)만 사용.
- **하네스 로컬 트랜스크립트 직접 파싱 금지** — `readHarnessTranscript`가 스키마 드리프트, `.jsonl.zst` 해제, `transcript_full.jsonl` 복원, `ses_` 속성 보정을 일괄 흡수.
