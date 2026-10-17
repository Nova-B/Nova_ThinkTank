# Nova ThinkTank

AI 직원들이 싱크탱크처럼 일하는 로컬 연구 사무실입니다. 사용자가 질문을 던지면 역할이 나뉜 AI 직원
(소장·리서처·레드팀·편집장)이 연구 과정을 거쳐 보고서를 만듭니다. 사무실 화면(M3)에서 그 과정을
실시간으로 보는 것이 목표이고, 지금은 터미널에 직원별 활동이 흘러갑니다.

직원은 이 PC에 설치·로그인된 **Claude Code**와 **Codex CLI**로 돌아갑니다(API 키 없음, 각 구독 한도 사용).
로그인 기능 없는 로컬 1인용 앱입니다.

> 현재 단계: **M1a** — 터미널에서 연구 하나를 끝까지 돌려 보고서를 만듭니다.
> 기획안: [`docs/plan.md`](docs/plan.md) · M0 검증: [`spikes/m0/RESULTS.md`](spikes/m0/RESULTS.md) · 검토 기록: [`docs/reviews/`](docs/reviews/)

## 연구 흐름 (M1a)

```
소장(Claude)        질문을 다듬고 리서처마다 관점·하위 질문 배정
  ↓
리서처 A(Claude) ┐  웹 검색으로 조사, 주장마다 근거(출처·발행일·확인일·구절)와 근거/추론 구분
리서처 B(Codex)  ┘  필요하면 사내 메신저(MCP)로 서로 질문 → 답을 받아 메모 수정
  ↓
레드팀(Codex)       1단계: 리서처 결론을 보기 전에 출처만 평가
                    2단계: 주장을 공격하고 "결론이 틀리는 조건"을 씀
  ↓
편집장(Claude)      발견 · 이견 · 반론에 대한 응답 · 행동 제안(거시/개인) · 미해결 질문
```

## 원칙

- 보고서에는 "결론" 섹션이 없습니다. **사용자의 가설 → 발견 → 이견 → 레드팀 반론과 응답 → 행동 제안 → 미해결 질문 → 근거 → 사후 검토** 순서입니다.
  AI의 답을 그대로 받아들이지 않게 하려는 장치입니다.
- 시작할 때 사용자의 예상을 먼저 묻습니다(건너뛸 수 있음). 보고서 맨 앞에 그대로 실립니다.
- 직원 권한은 프롬프트가 아니라 실행기가 강제합니다:
  - Claude: 내장 도구는 `WebSearch`·`WebFetch`만, `--strict-mcp-config`(사용자의 claude.ai 커넥터 차단), 사용자 설정·스킬 제외
  - Codex: `--ignore-user-config`, 읽기 전용 샌드박스, 셸·브라우저·컴퓨터 사용 등 기능 끔
  - 사내 메신저(MCP)는 실행 중인 자기 턴에서만, 같은 연구의 리서처에게만, 연구당 2개까지
- 산출물마다 스키마와 참조(주장 ID 등)를 서버가 검증하고, 실패하면 고쳐 달라고 다시 묻습니다.

## 요구 사항

- Windows 11에서 검증 (macOS·Linux는 미검증)
- Node.js 22 이상
- Claude Code, Codex CLI — 설치하고 로그인한 상태

## 사용법

```bash
npm install
npm run study -- "질문"                          # 시작 (내 예상을 먼저 묻는다)
npm run study -- "질문" --hypothesis "내 예상"    # 예상을 인자로
npm run study -- "질문" --export-dir <폴더>       # 보고서를 다른 폴더(예: Obsidian 볼트)에도 저장
npm run study -- --list                         # 연구 목록과 상태
npm run study -- --resume <studyId>             # 멈춘 연구 이어서
```

- **Ctrl+C** 한 번: 진행 중인 턴을 끝내고 저장한 뒤 멈춥니다(`paused`). 두 번: 즉시 종료.
- **한도**: Claude 5시간 한도 사용률이 90%를 넘거나 한도 오류가 나면 `waiting_limit`으로 멈춥니다. 재시도를 반복하지 않습니다.
- **이어서 실행**: 단계별 산출물이 체크포인트입니다. 끝난 단계는 다시 돌지 않습니다.
- 데이터는 `data/`(Git 제외)에 있습니다: `nova.db`(SQLite), `studies/<id>/report.md`, 직원 작업 폴더.

## 개발

```bash
npm test            # 단위 테스트 (가짜 실행기 — 실제 CLI를 부르지 않음)
npm run typecheck
npm run spike:probe # M0 스파이크 (실제 CLI 호출, 구독 사용량이 조금 듭니다)
```

## 참고

DeskRPG(Dante Labs)와 crew-office의 구조·아이디어를 참고했지만 코드·에셋은 가져오지 않았습니다.
