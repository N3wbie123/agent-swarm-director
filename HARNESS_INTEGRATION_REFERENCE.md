# 하네스 통합 레퍼런스 (`HARNESS_INTEGRATION_REFERENCE.md`)

> **대상**: ASD 오케스트레이터 CLI(TUI)/GUI 앱 개발팀
> **기준**: ASD v2.5.0 · 검증 기준일 2026-11-07 (로컬 실측 기반 — 추측 항목 없음, 미검증 항목은 명시)
> **제품 정의**: 새 하네스를 만들지 않는다. **기존 하네스의 대화 목록을 불러오고, 입력창으로 지시해 실행하며, 응답(Thinking·툴 호출·결과)을 실시간으로 렌더링한다.**

---

## 0. 리포 구조 권고 — 새 CLI(TUI)는 Core(asd-multiagent)와 분리

**결론: 분리한다.** 새 TUI는 Core SDK의 **소비자**로서 GUI(asd-gui)와 동급 클라이언트다.

| 이유 | 설명 |
|---|---|
| 경계 원칙 유지 | Core는 "CLI(`asd`) + 코어 관리 + 최소 SDK"만 유지하기로 v2.4.3에서 확정 (`CORE_GUI_BOUNDARY_AUDIT.md`). TUI를 Core에 넣으면 방금 정리한 경계를 다시 깬다. |
| Zero-dependency 불변식 | Core는 `dependencies: {}`를 CI 수준에서 강제 가능해야 한다. TUI 프레임워크(Ink/React 등) 의존성은 이 불변식을 깬다. |
| 릴리즈 독립성 | 하네스 어댑터/SDK는 자주 바뀌고, 앱은 패키징(exe) 주기가 별도다. npm GitHub 의존성(`agent-swarm-director`)으로 연결된 분리 모델은 asd-gui에서 이미 검증됨. |

**권장 배치**: TUI + GUI를 **하나의 앱 리포**에(공유 클라이언트 레이어: 세션 목록·스트리밍·전송 로직이 90% 동일). `asd-gui`를 발전시키거나(서버·인증·StateWatcher 재사용), 신규 리포에서 Core SDK만 import. **Core에 `asd chat`류 서브커맨드로 넣는 것은 금지** (의존성 오염 + 경계 회귀). 참고: Core의 기존 `asd` CLI 자체는 분리 대상이 아니다 — 그것은 코어 관리 CLI다.

## 1. 앱팀이 가져가야 할 문서 체크리스트

| 문서 | 용도 |
|---|---|
| **본 문서** (`HARNESS_INTEGRATION_REFERENCE.md`) | 하네스별 저장소·포맷·실측 이벤트 스키마·함정 — 통합 바이블 |
| `EXTERNAL_SDK_REFERENCE.md` | SDK 함수 시그니처, `core.db` 스키마, CLI 서브커맨드, `asd ui` HTTP API |
| `PROJECT_STATUS.md` | Core 전체 아키텍처 + 파일별 레퍼런스 |
| `ORCHESTRATOR_APP_PLAN.md` | 앱 아키텍처 계획(코어 서버 + TUI/GUI 클라이언트), 하네스 스트리밍 실측 매트릭스(부록 C) |
| `CORE_GUI_BOUNDARY_AUDIT.md` | Core–GUI 경계 원칙과 위반 판정 사례 — 앱이 Core에 요구하지 말아야 할 것의 기준 |
| `ROUTING_GUIDE.md` | 모델 라우팅 설정(하네스·모델 선택 UI 구현 시) |
| (asd-gui 기반 시) asd-gui의 `src/shared/protocol.ts`, `GUI_ARCHITECTURE.md` | 기존 REST/WS 계약과 ADR |

## 2. 공통 원칙 — 3계층 통합 모델

모든 하네스를 동일한 3단계로 다룬다. **ASD SDK가 전 단계를 이미 구현하므로 앱은 SDK를 호출하고 UI만 그린다.**

| 단계 | 기능 | SDK 함수 (모듈) |
|---|---|---|
| ① 세션 발견 | 프로젝트에서 실행된 5대 하네스 세션 일괄 스캔 (ASD 승격 여부 포함) | `discoverProjectCliSessions(projectRoot, opts?)` (`core/session-tracker`) |
| ② 트랜스크립트 로드 | 대화 기록을 user/assistant/thinking/tool_use/tool_result로 4분류 | `readHarnessTranscript(query)` (`core/transcripts`) |
| ③ 턴 실행 + 스트리밍 | 프롬프트 전송, 실시간 이벤트 수신, 세션 ID 자동 획득/저장 | `runDriverTurn(input)` + `parseDriverStreamLine` (`core/drivers`) |
| 보조 | 세션/드라이버 상태, 진행 보드, 서브세션 로그, 승격/하강 | `openProjectDb`, `attachDriver`/`detachDriver`, `renderProgressBoard`, `scanSubagentLogs`, `promoteCliSessionToAsd`/`demoteAsdSession` |

**이벤트 정규화 계약** (`DriverStreamEvent`, UI는 이것만 본다):
`thinking`(접이식 실시간 append) / `tool_use`(아이콘+이름+인자+스피너) / `tool_result`(접이식, `isError`시 빨강) / `text`(마크다운 점진) / `raw`(파싱 불가 라인) + `harnessSessionId`, `toolId` 메타. 하네스 차이는 파서가 흡수하므로 UI에 하네스 분기가 없어야 한다.

---

## 3. 하네스별 통합 카드

### 3.1 Claude Code (`claude` v2.1.317) — 블록 실시간 (partial 옵션 시 토큰)

| 항목 | 내용 |
|---|---|
| 세션 저장 | `~/.claude/projects/<cwd-인코딩>/<uuid>.jsonl` — **포맷 불안정 공식 경고** (직접 파싱 금지, `readHarnessTranscript` 사용) |
| 스트리밍 | `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages` |
| 이벤트 (실측) | `system/init`(session_id·tools·model) → `stream_event`(content_block_delta: `text_delta`/`thinking_delta`/`input_json_delta`) → `assistant`(완성 블록: text/thinking/tool_use) → `user`(tool_result 운반) → `result`(최종 + cost + session_id) |
| 전송/이어하기 | `-p` + `--resume <uuid>` (스트리밍 동시 가능), `--continue`, `--fork-session` |
| 권한/승인 | `--permission-mode`, `--permission-prompts host\|none`, SDK `canUseTool` (v2 확장용) |
| 함정 | ①긴 프롬프트는 stdin 전달 권장 ②`--dangerously-skip-permissions` 필요시 명시 ③세션 JSONL은 버전마다 드리프트 → 회귀 테스트 필수 |

### 3.2 OpenCode (`opencode` v1.19.4) — 블록 실시간 (토큰은 serve+SSE만, P2 과제)

| 항목 | 내용 |
|---|---|
| 세션 저장 | `~/.local/share/opencode/opencode.db` (SQLite WAL, 수 GB) — `session_v2`/`session_message` 테이블. 경로 확인: `opencode debug paths db` |
| 스트리밍 | `opencode run "<prompt>" --format json` — **part 완료 단위**(15문장이 단일 `text` 이벤트로 도착하는 것을 실측). 이벤트: `step_start` → `text` → `step_finish`(tokens·cost) |
| 토큰 실시간 (P2) | `opencode serve` + SSE `GET /api/event/subscribe`(`session.message.part.updated` 델타) — 상주 서버 관리 필요. `run --attach http://localhost:4096`으로 콜드부트(~28초) 완화 |
| 전송/이어하기 | `run -s <ses_...>` / `-c` / `--fork`; `opencode export <id>`(JSON 덤프), `session list` |
| 권한/승인 | `--auto` (비거부 자동 승인), permissions API (v2) |
| 함정 | ①DB 잠금 중 읽기 실패 가능(재시도 필요) ②수 GB DB 전체 스캔 금지 — 세션 ID 스코프 쿼리만 ③ID가 `ses_` 접두사 |

### 3.3 Codex CLI (`codex` v0.166.0) — 이벤트 실시간

| 항목 | 내용 |
|---|---|
| 세션 저장 | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` — **구세션은 `.jsonl.zst`(zstd)** → 히스토리 전체 로드 시 복원 필요. 엔벨로프: `{timestamp, ordinal, type: session_meta\|event_msg\|response_item\|turn_context, payload}` |
| 스트리밍 | `codex exec "<prompt>" --json` |
| 이벤트 (실측) | `thread.started`(thread_id) → `turn.started` → `item.started\|completed`(item.type: `agent_message`/`reasoning`/`command_execution`(aggregated_output, exit_code)/`file_change`/`mcp_tool_call`) → `turn.completed`(usage) |
| 전송/이어하기 | `codex exec resume <id> "<prompt>" --json` / `--last`, `codex fork` |
| 상호작용 풀옵션 (v2) | `codex app-server` JSON-RPC — `initialize` 핸드셰이크 → `thread/start\|resume\|fork`, `turn/start\|steer\|interrupt`, 승인 RPC(`execCommandApproval`). `codex app-server generate-ts`로 TS 바인딩 생성 |
| 권한/승인 | `--sandbox read-only\|workspace-write`, `--dangerously-bypass-approvals-and-sandbox`, app-server 런타임 승인 |
| 함정 | ①stdin 파이프 환경에서 stdin을 닫아야 함(안 닫으면 "Reading additional input from stdin..." 대기) ②SDK `@openai/codex-sdk` 존재 |

### 3.4 Antigravity (`agy` v1.5.1) — 토큰 실시간 (최고 등급)

| 항목 | 내용 |
|---|---|
| 세션 저장 | `~/.gemini/antigravity-cli/conversations/<id>.db` (SQLite) + `brain/<id>/.system_generated/logs/transcript.jsonl` — `truncated_fields` 있으면 `transcript_full.jsonl` 폴백 |
| 스트리밍 | `agy -p "<prompt>" --output-format stream-json` |
| 이벤트 (실측) | `{"event":"init","conversation_id":...}` → `{"event":"step_update","step_update":{"state":"ACTIVE\|DONE","step_type":"agent_response","text_delta":"..."}}` **~25ms 토큰 델타** → `{"event":"result","result":{"response":전문,"status":"SUCCESS"}}` |
| 전송/이어하기 | `-p --conversation <id>`, `-c`(최근), `--input-format stream-json`(단일 프로세스 상주 멀티턴) |
| 권한/승인 | `--dangerously-skip-permissions` 또는 `--sandbox` |
| 함정 | ①`result.response`가 델타 전문과 중복 → UI dedup 필요(ASD `onAssistantText`가 처리) ②파서의 구 `PLANNER_RESPONSE` 분기는 transcript.jsonl 포맷용 ③App(IDE) 아티팩트는 별도 Markdown(`~/.gemini/antigravity/brain/<id>/*.md`) |

### 3.5 Cursor CLI (`cursor-agent`) — thinking 토큰 + 툴 라이프사이클 실시간, 텍스트 블록

| 항목 | 내용 |
|---|---|
| 세션 저장 | `~/.cursor/chats/<workspace-md5>/<chat-uuid>/store.db`(SQLite, **비공개 blob 포맷**)+`meta.json` → **트랜스크립트 읽기 unsupported**. 유일한 대안: lossy 내보내기 `~/.cursor/projects/<dir>/agent-transcripts/*.jsonl`(도구 결과 미포함) |
| 스트리밍 | `cursor-agent -p "<prompt>" --force --output-format stream-json` |
| 이벤트 (실측) | `system/init`(session_id) → **`user` 프롬프트 에코(스킵 필수)** → `{"type":"thinking","subtype":"delta","text":...}` 톱레벨 델타 → `{"type":"tool_call","subtype":"started\|completed","call_id":...,"tool_call":{"<family>ToolCall":{"args":...,"result":{"success":...}\|{"error":{"errorMessage":...}}}}}` → `assistant`(블록, `model_call_id` 유무로 플러시 구분) → `result` |
| 전송/이어하기 | `--resume <chatId>`, `--continue`, `agent ls`(목록), `create-chat`(빈 채팅 ID 선점) |
| 권한/승인 | `--force`(`--yolo`), `--auto-review`(서버 분류 자동 승인) |
| 함정 | ①**`.ps1` 래퍼** — node spawn 시 `powershell -File` 또는 `.cmd` shim 사용 ②IDE와 CLI 세션 저장소 분리 ③`--stream-partial-output`는 델타+버퍼플러시 중복을 유발하므로 미사용 권장(`model_call_id` 유무로 구분 가능하나 파서 미구현) ④tool_result 출력 위치: `tool_call.<family>ToolCall.result.success` / `.error.errorMessage` |

---

## 4. ASD SDK → 앱 기능 매핑 (무엇을 직접 만들지 말지)

| 앱 기능 | 구현 | 직접 만들 것인가? |
|---|---|---|
| 대화 목록 (5하네스) | `discoverProjectCliSessions` | ❌ SDK 호출 |
| 세션 기록 뷰 (4분류) | `readHarnessTranscript` | ❌ SDK 호출 (하네스별 파서 내장) |
| 입력 → 실행 + 실시간 렌더 | `runDriverTurn({ onEvent, streaming: true })` | ❌ SDK 호출 — UI 렌더만 |
| 세션 이어하기 | `runDriverTurn`이 `harness_session_id` 자동 resume | ❌ |
| 진행 보드 (ASD 세션) | `asd status --json` / `renderProgressBoard` | ❌ |
| 서브세션 로그 테일 | `scanSubagentLogs` + 파일 tail | ❌ |
| 권한 승인 UI (v2) | 하네스별: SDK `canUseTool` / app-server RPC / permissions API | ⭕ UI만 (계약은 SDK) |
| OpenCode 토큰 스트리밍 (v2) | `opencode serve` + SSE 통합 | ⭕ 신규 (P2 과제) |
| 세션 검색/메모/그룹핑 | `saveSessionMemo`, `listKnownProjects` | ❌ SDK 호출 |

**앱에서 절대 하지 말 것**: 하네스 CLI 플래그 조립을 앱에서 직접 하지 마라(어댑터/빌더가 소유) — 세션 ID 형식으로 하네스를 추측하지 마라(`ses_`=OpenCode 불변식은 Core가 보장) — `.asd/`를 파일 도구로 직접 수정하지 마라(공식 SDK/CLI만) — Core에 UI 코드를 요청하지 마라(`CORE_CHANGE_REQUEST` 절차, GUI_ARCHITECTURE ADR-01-3).

---

## 5. 함정 요약 매트릭스 (운영 시 주의)

| 함정 | 영향 하네스 | 완화 |
|---|---|---|
| stdin 파이프 대기 | Codex | stdin 즉시 닫기 |
| 콜드부트 ~28초 | OpenCode | `run --attach` 웜서버, 또는 serve 상주 |
| 구세션 `.jsonl.zst` | Codex | 로드 시 zstd 복원 |
| DB 잠금 (WAL) | OpenCode (2.2GB+), Cursor store.db | 재시도 + 세션 스코프 쿼리만 |
| 세션 JSONL 포맷 드리프트 | Claude | `readHarnessTranscript` 경유 + 회귀 테스트 |
| user 프롬프트 에코 | Cursor | 파서가 스킵 (v2.4.3부터) |
| result 전문 중복 | Antigravity | UI dedup (ASD 내장) |
| `.ps1` 래퍼 | Cursor | `powershell -File` 또는 `.cmd` 경유 spawn |
| 트랜스크립트 미제공 | Cursor | unsupported + lossy jsonl 대안 (P4 과제) |
| 훅 브리지 오표기 | OpenCode(OMO 미러) | Core가 `ses_` 보정 + 자가 치유 (v2.4.3) |

---

## 6. 검증 방법 (구현 후 반드시)

1. **이벤트 파서**: 실측 바이트를 `parseDriverStreamLine`에 투입해 카테고리 단위 검증 (ASD `driver-runner.test.ts`·`driver-hooks.test.ts` 패턴 참조)
2. **터치 테스트**: 각 하네스로 `runDriverTurn` 1턴 실행 — thinking/tool_use/tool_result/text 수신 + `harnessSessionId` 자동 저장 확인
3. **세션 로드**: 각 하네스로 대화 1건 생성 후 `discoverProjectCliSessions` + `readHarnessTranscript` 라운드트립
4. **전체 회귀**: `node scripts/run-tests.mjs` (Core) — 앱 리포라면 자체 테스트
