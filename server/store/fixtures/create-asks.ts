// store.test.ts가 별도 프로세스로 띄워 같은 DB 파일에 동시에 질문을 쓴다
import { Store } from "../store.js";

const [file, studyId, from, count] = process.argv.slice(2) as [string, string, string, string];
const store = new Store(file);
for (let i = 0; i < Number(count); i++) {
  store.createAsk({ studyId, from, to: "other", question: `${from} 질문 ${i}`, turnId: null, maxPerEmployee: 1000 });
}
store.close();
