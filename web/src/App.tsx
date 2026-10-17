import { useEffect, useState } from "react";
import { api } from "./api";
import { Lobby } from "./components/Lobby";
import { StudyView } from "./components/StudyView";
import type { Employee, RateInfo } from "./types";

type Route = { page: "lobby"; tank: string | null } | { page: "study"; id: string };

function parse(hash: string): Route {
  const study = hash.match(/^#\/study\/([\w-]+)/);
  if (study) return { page: "study", id: study[1]! };
  const tank = hash.match(/^#\/tank\/([\w-]+)/);
  return { page: "lobby", tank: tank ? tank[1]! : null };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const [meta, setMeta] = useState<{ roster: Employee[]; stages: string[]; rate: RateInfo | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onHash);
    api.meta().then(setMeta, (e: Error) => setError(e.message));
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (error) return <p className="page-error">서버에 연결하지 못했습니다: {error}. 터미널에서 npm run office가 켜져 있는지 확인하세요.</p>;
  if (!meta) return null;
  return route.page === "study" ? (
    <StudyView key={route.id} id={route.id} roster={meta.roster} stages={meta.stages} initialRate={meta.rate} />
  ) : (
    <Lobby tank={route.tank} />
  );
}
