"use client";

interface Props {
  text: string;
  author?: string;
}

export default function ChatBubble({ text, author }: Props) {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-400 max-w-xs">
      <div className="relative bg-black/75 backdrop-blur-md border border-white/20 rounded-2xl rounded-bl-sm px-4 py-3">
        {author && (
          <p className="text-blue-300 text-xs font-bold mb-1 uppercase tracking-wide">{author}</p>
        )}
        <p className="text-white text-sm leading-snug">{text}</p>
        {/* bubble tail */}
        <div className="absolute -bottom-2 left-4 w-4 h-4 bg-black/75 border-r border-b border-white/20 rotate-45 rounded-br-sm" />
      </div>
    </div>
  );
}
