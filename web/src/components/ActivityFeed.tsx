import { useEffect, useRef } from "react";
import type { FeedItem } from "../office/state";
import type { Employee } from "../types";
import { formatTime } from "./labels";

interface Props {
  roster: Employee[];
  feed: FeedItem[];
  selected: string | null;
  selectedLabel: string | null;
  onClear: () => void;
}

export function ActivityFeed({ roster, feed, selected, selectedLabel, onClear }: Props) {
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const items = selected ? feed.filter((f) => f.employeeId === selected || f.employeeId === null) : feed;
  const names = new Map(roster.map((e) => [e.id, e]));

  // 맨 아래를 보고 있을 때만 새 기록을 따라 내려간다
  // 기록은 400개에서 앞이 잘리므로 길이가 아니라 마지막 항목으로 새 기록을 알아챈다
  const lastKey = items.length ? `${items.at(-1)!.id}-${items.at(-1)!.text}` : "";
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastKey]);

  return (
    <aside className="feed" aria-label="활동 기록">
      <div className="feed-head">
        <h2>{selectedLabel ? `${selectedLabel}의 기록` : "활동 기록"}</h2>
        {selected ? (
          <button type="button" className="quiet" onClick={onClear}>
            모두 보기
          </button>
        ) : null}
      </div>
      <ol
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 ? <li className="feed-empty">아직 기록이 없습니다.</li> : null}
        {items.map((f, i) => {
          const emp = f.employeeId ? names.get(f.employeeId) : undefined;
          return (
            <li key={`${f.id}-${i}`} className={`tone-${f.tone}${emp?.role === "redteam" ? " is-red" : ""}`}>
              <time>{formatTime(f.at)}</time>
              {f.tone === "stage" ? (
                <strong className="stage-line">{f.text} 단계</strong>
              ) : (
                <span>
                  {emp ? <b>{emp.label}</b> : null} {f.text}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
