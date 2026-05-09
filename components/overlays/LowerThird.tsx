"use client";

interface Props {
  name: string;
  subtitle: string;
}

export default function LowerThird({ name, subtitle }: Props) {
  return (
    <div className="animate-in fade-in slide-in-from-left-8 duration-500">
      <div className="flex items-stretch">
        <div className="w-1 bg-blue-500 rounded-full mr-3 shadow-[0_0_8px_#3b82f6]" />
        <div className="bg-black/80 backdrop-blur-md border border-white/20 px-5 py-3 rounded-r-xl">
          <p className="text-white font-bold text-lg leading-tight tracking-tight">{name}</p>
          <p className="text-blue-300 text-sm mt-0.5 font-mono">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}
