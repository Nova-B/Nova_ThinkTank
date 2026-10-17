# Nova ThinkTank

AI 직원들이 싱크탱크처럼 일하는 로컬 연구 사무실입니다. 사용자가 탐구 주제(ThinkTank)를 만들고 질문을 던지면,
역할이 나뉜 AI 직원(소장·분야 리서처·시나리오 플래너·레드팀·편집장)이 연구 과정을 거쳐 보고서를 만들고,
그 과정을 2D 사무실 화면에서 실시간으로 보여 줍니다.

직원은 이 PC에 설치·로그인된 **Claude Code**와 **Codex CLI**로 돌아갑니다(API 키 없음, 각 구독 한도 사용).
로그인 기능 없는 로컬 1인용 앱입니다.

> 현재 단계: **M0 검증 완료** — 제품 코드는 아직 없고, CLI 동작 검증 스파이크만 있습니다.
> 기획안: [`docs/plan.md`](docs/plan.md) · M0 결과: [`spikes/m0/RESULTS.md`](spikes/m0/RESULTS.md)

## 원칙

- 보고서는 결론을 내려 주는 대신 **사용자의 가설 → 발견 → 시나리오 → 이견 → 행동 제안 → 미해결 질문** 순서로 씁니다.
  AI의 답을 그대로 채택하지 않도록 레드팀 반론 단계는 건너뛸 수 없습니다.
- 주장마다 근거(출처·발행일·확인일)와 "직원 추론" 여부를 구분합니다.
- 목표: 직원은 읽기 전용으로 실행되고 웹 검색과 사내 메신저(MCP) 도구만 씁니다. (M0 스파이크는 이 제한을 일부만 적용합니다. 강제는 M1a에서 구현)

## 요구 사항

- Windows 11에서 검증 (macOS·Linux는 미검증)
- Node.js 22 이상
- Claude Code, Codex CLI — 설치하고 로그인한 상태

## 스파이크 실행

```bash
npm install
npm run spike:probe       # 이벤트 형식·세션 재개
npm run spike:roundtrip   # 직원 간 질문 왕복 (Claude↔Codex)
npm run spike:isolation   # 격리·웹 검색·읽기 전용·취소
```

실제 CLI를 부르므로 구독 사용량이 조금 듭니다.

## 참고

DeskRPG(Dante Labs)와 crew-office의 구조·아이디어를 참고했지만 코드·에셋은 가져오지 않았습니다.
