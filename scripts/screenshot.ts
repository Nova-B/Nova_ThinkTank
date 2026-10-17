// 사무실 화면 스크린샷. 설치된 Edge(또는 Chrome)를 그대로 쓰므로 브라우저를 따로 받지 않는다.
//   npx tsx scripts/screenshot.ts <url> <저장할 png> [너비] [높이] [--dark]
import { chromium } from "playwright-core";

const [url, out, w = "1440", h = "1300", ...flags] = process.argv.slice(2);
if (!url || !out) {
  console.error("사용법: npx tsx scripts/screenshot.ts <url> <png> [width] [height] [--dark]");
  process.exit(2);
}
const channel = process.env.NOVA_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome");
const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: Number(w), height: Number(h) },
    colorScheme: flags.includes("--dark") ? "dark" : "light",
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // 스트림 연결은 계속 열려 있어 networkidle을 기다릴 수 없다 → 그림이 그려질 시간만 준다
  await page.waitForTimeout(2500);
  // --tab <이름>: 연구 화면 아래 탭을 눌러 그 패널을 보이게 한 뒤 찍는다
  const tab = flags.indexOf("--tab");
  if (tab >= 0 && flags[tab + 1]) {
    await page.getByRole("tab", { name: flags[tab + 1] }).click();
    await page.waitForTimeout(1500);
    await page.locator("[role=tabpanel]").scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: out, fullPage: !flags.includes("--viewport") });
  if (errors.length) console.log("브라우저 오류:\n" + errors.join("\n"));
  console.log(`저장: ${out}`);
} finally {
  await browser.close();
}
