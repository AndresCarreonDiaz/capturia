"use client";

type Keyword = string | { text?: string; label?: string; word?: string; value?: string };

interface Props {
  keywords: Keyword[];
  color: string;
}

function toText(kw: Keyword): string {
  if (typeof kw === "string") return kw;
  return kw.text ?? kw.label ?? kw.word ?? kw.value ?? String(kw);
}

export default function KeywordHighlight({ keywords, color }: Props) {
  return (
    <div className="flex flex-wrap gap-2 animate-in fade-in duration-300">
      {keywords.map((kw, i) => (
        <span
          key={i}
          className="px-3 py-1 rounded-full text-sm font-bold uppercase tracking-widest border"
          style={{
            color,
            borderColor: color,
            boxShadow: `0 0 12px ${color}80, inset 0 0 8px ${color}20`,
            backgroundColor: `${color}15`,
          }}
        >
          {toText(kw)}
        </span>
      ))}
    </div>
  );
}
