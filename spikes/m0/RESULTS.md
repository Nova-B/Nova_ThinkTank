# M0 검증 스파이크 결과 (2026-10-17)

Windows 11, Node 22.17.0, **Claude Code 2.1.302** (`--model haiku`), **codex-cli 0.163.0** (`model_reasoning_effort="low"`).
두 CLI 모두 API 키 없이 계정 로그인으로 실행했다. 실행 로그와 요약(`logs/`)은 로컬 경로·설치된 스킬과 플러그인 목록·세션 ID가 들어 있어 Git에 올리지 않는다. 이 문서가 공개용 요약이다.

실행: `npm run spike:probe`, `npm run spike:roundtrip`, `npm run spike:isolation`

## 요약

| # | 확인 항목 | 결과 | 설계에 주는 의미 |
| --- | --- | --- | --- |
| 1 | Claude 세션 ID를 앱이 먼저 정하기 | ✅ `--session-id <uuid>` → `system/init`과 `result`에 같은 ID | **턴 시작 전에 세션 ID를 DB에 저장할 수 있다** (Codex 검토 의견 반영 가능) |
| 2 | Claude 재개 후 기억 | ✅ `--resume` | |
| 3 | Codex 세션 ID·재개 | ✅ `thread.started.thread_id`, `exec resume <id>` | Codex는 ID를 미리 정할 수 없다 → 첫 이벤트를 받는 즉시 저장 |
| 4 | Claude 이벤트 종류 | `system/init`, `assistant`, `rate_limit_event`, `result/success` | |
| 5 | **Claude 사용 한도 정보** | ✅ `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization`, `resetsAt` | 구독 한도를 비율로 보여 주고, 임계치에서 `한도 대기`로 넘길 수 있다 |
| 6 | Codex 이벤트 종류 | `thread.started`, `turn.started`, `item.completed/{agent_message,web_search,mcp_tool_call}`, `turn.completed` | `text_delta` 같은 증분은 없다. 항목 단위로 화면을 갱신한다 |
| 7 | Codex 사용량 | `turn.completed.usage` 토큰만 (입력 3.4만 중 2.9만 캐시) | 비용·한도 비율은 없음 |
| 8 | `--ignore-user-config` | ✅ 로그인 유지된 채 동작 | Codex 직원 기본값으로 쓴다 |
| 9 | **직원 간 왕복 (Claude→Codex)** | ✅ `ask_colleague` → 큐 → Codex 답변 → Claude 재개 후 `check_answers`로 확인코드까지 수신 | 비동기 큐 설계가 실제로 동작 |
| 10 | **직원 간 왕복 (Codex→Claude)** | ✅ `approval_mode="approve"`를 두 도구에만 지정해 성공 | 도구별 승인으로 충분 |
| 11 | Claude MCP 도구 노출 | `--tools ""` + `--strict-mcp-config`이면 MCP 도구가 바로 보이고 `ToolSearch` 없이 호출 | crew-office 스파이크 때보다 턴이 하나 줄었다 |
| 12 | Claude 격리: `--strict-mcp-config` | ✅ claude.ai 커넥터(Gmail·Docs 등)가 빠지고 `office`만 남음 | **필수.** 없으면 사용자의 Gmail·Docs 커넥터가 직원에게 붙는다 |
| 13 | Claude 격리: `--safe-mode` | ❌ `--mcp-config`의 MCP 서버까지 꺼진다 (`mcp: []`) | 쓰지 않는다 |
| 14 | 스킬·플러그인·자동 메모리 | ⚠️ `--strict-mcp-config`만으로는 스킬 37개·플러그인·`memory_paths`가 남는다 | 직원 작업 폴더를 `data/` 아래 고정 → 자동 메모리 경로도 그 폴더 기준으로 갈린다. 추가 격리는 M1에서 다시 본다 |
| 15 | Claude 웹 검색 | ✅ `--tools "WebSearch,WebFetch"` + `--allowedTools` 같은 값 → 마지막 실행에서 `WebSearch` 2회·`WebFetch` 1회 호출, 권한 거부 없음 | "거부 없음"과 "가져오기 성공"은 다르다. iea.org는 403으로 열리지 않아 검색 요약에 기대 답했다 → 출처 확인 실패를 산출물에 표시해야 한다 |
| 16 | Codex 웹 검색 | ✅ `-c web_search="live"` → `web_search` 항목 3개 | 검색과 페이지 열기가 같은 `web_search` 타입이라 항목 수 ≠ 검색 횟수 |
| 17 | Codex 읽기 전용 | ⚠️ 파일은 생기지 않았다. 하지만 이벤트에 `command_execution`이 없고 모델이 "정책상 차단"이라고 말만 했다 | **OS 샌드박스가 실제 쓰기를 막았는지는 미검증.** M1a에서 명령을 실제로 실행시키는 시험을 다시 한다 |
| 18 | 턴 도중 트리 종료 (`taskkill /T /F`) | ✅ 종료 코드 1, 종료 1.5초 뒤 `office-mcp.ts` node 프로세스 0개, `--resume`으로 앞 요청을 기억 | 턴 실행 중에 MCP 프로세스가 떠 있었는지는 세지 않아 **자식 정리 보장은 미검증**. 요청을 기억하는 것과 중단된 작업을 안전하게 복구하는 것도 별개다 |

검증 범위: #5는 한도 정보가 **보인다**는 것까지만 확인했다(한도 소진 후 대기·재개는 미검증). #9·#10은 **순차 실행**에서의 왕복이다. 동시에 여러 요청이 큐에 쓰일 때는 시험하지 않았고, 스파이크의 JSON 파일 큐는 동시 쓰기에서 요청을 잃을 수 있다.

참고: 같은 질문("가장 최근 IEA 보고서")에 Claude와 Codex가 **서로 다른 보고서**를 찾았다. 둘을 섞으면 검색 결과가 실제로 다양해질 수 있다는 단서다. 다만 이것만으로 판단이 독립적이라고 볼 수는 없다.

## 직원 실행 기본 인자 (M1에서 사용)

**Claude 직원**

```
claude -p --output-format stream-json --verbose
  --model <model> --session-id <미리 만든 uuid>   # 재개: --resume <uuid>
  --append-system-prompt <역할 지침>
  --tools "WebSearch,WebFetch"
  --mcp-config <office 서버 JSON> --strict-mcp-config
  --allowedTools "WebSearch,WebFetch,mcp__office__ask_colleague,mcp__office__check_answers,..."
```

**Codex 직원**

```
codex exec [resume <thread_id>] --json --skip-git-repo-check --ignore-user-config
  -c sandbox_mode="read-only" -c model_reasoning_effort=<..> -c web_search="live"
  -c developer_instructions=<역할 지침>
  -c mcp_servers.office.{command,args,env}=...
  -c mcp_servers.office.tools.<도구>.approval_mode="approve"   # 허용 도구마다
  -
```

## M1a로 가져갈 때 바꿀 것 (Codex 코드 검수 반영, `docs/reviews/2026-10-17_m0-code.md`)

- **실행기**: 프로세스 실행과 엔진별 인자·이벤트 해석을 나눈다. 기본 마감 시간, 취소, 종료 확인, 출력 크기 제한을 둔다.
- **이벤트 정규화**: 모든 이벤트에 `studyId / runId / employeeId / sequence`를 붙인다. 도구 요청·성공·실패와 턴 성공·실패·취소를 구분한다. 완료 조건은 종료 코드 + 최종 이벤트 + 산출물 검증 셋 다 통과.
- **큐**: 파일 큐 대신 중앙 서버가 SQLite 트랜잭션으로 관리한다. 요청 ID, 중복 방지 키, 상태, 처리 임대(lease), 재시도 횟수.
- **권한**: MCP 도구에서도 직원·Study별 접근 범위를 검사한다(작업 폴더·읽기 전용 설정만으로는 MCP의 접근을 막지 못한다).

## 아직 확인하지 않은 것

- Claude `--json-schema` / Codex `--output-schema`로 단계 산출물을 구조화했을 때의 이벤트 모양 → M1a 첫 작업
- Codex 턴 도중 종료 후 재개
- 직원 여럿을 동시에 띄웠을 때의 부하와 한도 소모 속도
- 스킬·플러그인을 더 줄이는 방법 (`--disable-slash-commands` 등)
