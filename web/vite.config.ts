import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 서버(server/cli/office.ts)가 이 설정으로 Vite를 미들웨어 모드로 띄운다. 별도 개발 서버는 없다.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
