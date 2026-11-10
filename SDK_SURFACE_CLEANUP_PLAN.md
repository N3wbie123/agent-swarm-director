# SDK 표면 정리 계획 (SDK_SURFACE_CLEANUP_PLAN.md)

> **작성 배경** (2026-11-10): ASD-Nexus를 완전히 갈아엎기로 했으므로, 기존 소비자 호환성 유지 부담이 사라지는 시점에 SDK 공개 표면에서 제거할 후보들과 근거·조건을 기록한다. 전제는 `ponytail-audit` 전수 감사 결과를 "외부 호환성 / 유지보수 / 프로젝트 목표" 필터로 재판정한 것.

---

## 0. 문서-코드 불일치 (재작성 전 반드시 확인)

**`startDashboardServer`가 루트 export에 존재한다.**
- `src/index.ts`가 `export { startDashboardServer, type DashboardServerHandle } from "./cli/dashboard.ts"`를 수행 중.
- 그러나 `CORE_GUI_BOUNDARY_AUDIT.md` W2는 "루트 export 제거 완료"라고 기록했고, `PROJECT_STATUS.md`·`PATCH_NOTES.md`(v2.4.3)도 "루트 엔트리 미노출, 서브패스 `cli/dashboard` 전용"이라고 기술한다.
- `tests/dashboard-exports.test.ts:101`이 루트 export를 핀하고 있어 회귀 또는 문서 오류 중 하나. **Nexus 재작성 시 루트 export 제거가 1순위** — 문서가 이미 약속한 상태로 되돌리는 것. (테스트는 `cli/dashboard` 서브패스 import로 전환)

---

## 1. 제거 후보 항목

| # | 심볼 | 위치 | 현재 상태 | 핀/문서 | 제거 조건 |
|---|------|------|-----------|---------|-----------|
| 1 | `startDashboardServer` (루트 export) | `src/index.ts:72-75` | 문서상은 이미 비노출이어야 함 | dashboard-exports.test.ts:101 핀 | 즉시 제거 가능 (문서와의 불일치 해소). 서브패스 `./cli/dashboard`는 유지 |
| 2 | `installGlobalConfigs` | `installer.ts:1525` | `syncHarnessConfigs`의 미사용 alias | 핀 없음, 문서 없음 | 즉시 제거 가능 |
| 3 | `registerCoreHarnessProvisioner` / `getCoreHarnessProvisioner` | `types.ts:523-524` | 레지스트리 함수의 미사용 alias | 핀 없음, 문서 없음 | 즉시 제거 가능 |
| 4 | `syncRepoVersionStrings` | `installer.ts:973-975` | 의도적 no-op (설계 노트 주석) | installer-sync.test.ts:482가 no-op 동작 핀 | 제거 + 해당 테스트 케이스 삭제. 역사 문서 무변경 보장은 `syncHarnessConfigs` 테스트가 계속 담당 |
| 5 | `approveTaskWorktree` / `rejectTaskWorktree` | `workspace.ts:1810,1881` | `approve/rejectPendingTask` alias | dashboard-exports.test.ts:105-108이 identity 핀 | 제거 + 테스트 2개 assertion 삭제 |
| 6 | `isProtectedPath` | `policy.ts:309` | `checkProtectedPath` alias | policy-failclosed.test.ts:15 import | 제거 + 테스트 import 전환 |
| 7 | `buildResumeHarnessCommand` positional 시그니처 | `session-tracker.ts:179-204` | positional + options 이중 지원 | 문서(`PROJECT_STATUS`/SDK 레퍼런스)는 options형만 기술. 내부 positional 호출 1곳(`subagent-control.ts:452`) | options 전용으로 축소 + 내부 호출 1곳 수정 |
| 8 | `verifyPidIdentity(pid, expectedStartedAt)`의 `expectedStartedAt` | `workspace.ts:1239-1242` | `void`로 무시되는 스텁 파라미터. 호출부 2곳이 값을 전달 | 문서화 없음 | (a) 시작시각 검증 구현, 또는 (b) 파라미터 제거 + 호출부 2곳 정리. 시그니처 변경이므로 Nexus 재작성 시점에 결정 |
| 9 | `src/adapters/claude.ts` | 5줄 re-export alias | 내부 import 0개 (grep 확인) | 문서 참조 없음 | 제거 가능. 단 서브패스 `agent-swarm-director/adapters/claude` import가 깨지므로 제거 시 minor 버전 bump |

### 유지 확정 (제거하지 않는 것)
- **package.json `.ts` export 패턴** (`./core/*.ts` 등 4줄): 로드베어링. `./core/*` 패턴 하나만 남기면 `./core/db.ts` 요청이 `*`=`db.ts`로 치환되어 `db.ts.ts`를 찾게 됨. 명시 패턴이 `.ts` 서브패스 import를 해결함. (초기 감사에서 "중복"으로 잘못 판정 → 철회)
- **`claude.ts`를 제외한 어댑터 파일들, `presets/`, `scripts/run-tests.mjs`**: 모두 활성.
- **`ORCHESTRATOR_APP_PLAN.md` / `ROUTING_GUIDE.md` 등 루트 문서 전체**: 상호 참조망(PATCH_NOTES·PROJECT_STATUS·HARNESS_INTEGRATION_REFERENCE)이 살아있어 전부 유지. 임시 파일은 추적 외 junk만 제거 완료(`-/` 디렉터리, `.omo/새 텍스트 문서.txt`).

---

## 2. 제거 절차 (Nexus 재작성 시작 시)

1. 위 표 1~9번을 한 커밋(또는 항목별 소커밋)으로 제거. 각 항목의 "제거 조건" 열에 적힌 테스트 수정을 동반.
2. `EXTERNAL_SDK_REFERENCE.md`의 모듈별 export 표에서 해당 심볼 삭제, `PROJECT_STATUS.md` 공개 표면 섹션 갱신.
3. `startDashboardServer` 제거 시 `CORE_GUI_BOUNDARY_AUDIT.md` W2 항목의 상태를 실제 코드와 일치시키고, 회귀 원인(재추가 시점 커밋)을 패치노트에 기록.
4. 패키지 버전을 minor 이상으로 상향 (서브패스 1개 제거는 breaking).

## 3. ASD-Nexus 마이그레이션 체크리스트

- [ ] Nexus가 `agent-swarm-director` 루트 엔트리(`.`)에서 import하는 심볼 목록 추출 → 위 표와 대조
- [ ] `startDashboardServer`를 쓰고 있다면 자체 서버로 대체 (경계 원칙상 원래 GUI 소속)
- [ ] positional `buildResumeHarnessCommand` 사용 여부 확인 → options 객체로 전환
- [ ] `verifyPidIdentity` 두 번째 인자 의존 여부 확인 (현재 무시되므로 의존하면 안 됨)
- [ ] `adapters/claude` 서브패스 import 여부 확인 → `adapters/claude-code`로 변경

## 4. 참고: 리스크 0 정리 (이미 완료, 2026-11-10)

- mcp/server.ts `buildPromptForTask` dead block 삭제 (위임만 유지, 출력 불변)
- 락 구현 2벌 → `core/file-lock.ts` 단일 구현 (타임아웃·백오프·에러라벨 동작 보존, CR-11 테스트 통과)
- `buildDefaultHarnessCommand` → `buildHeadlessHarnessCommand` 위임 (명령 테이블 드리프트 제거)
- `detectSystemLocale` 3벌 → models.ts 1개, `resolveHome` 3벌 → `config.resolveHomeDir` 1개
- `probeHeadlessBinary` 통합, `toStringArray` 호이스트, 루트 barrel 중복 re-export 제거
- 검증: `scripts/run-tests.mjs` 405/405 통과
