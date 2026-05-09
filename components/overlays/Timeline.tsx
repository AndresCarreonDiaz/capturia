"use client";

interface Step {
  label: string;
}

interface Props {
  steps: Step[];
  currentStep: number;
}

export default function Timeline({ steps, currentStep }: Props) {
  return (
    <div className="bg-black/70 backdrop-blur-md border border-white/20 rounded-xl px-5 py-3 animate-in fade-in duration-300">
      <div className="flex items-center gap-0">
        {steps.map((step, i) => {
          const active = i === currentStep;
          const done = i < currentStep;
          return (
            <div key={i} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors ${
                    active
                      ? "bg-blue-500 border-blue-400 text-white shadow-[0_0_12px_#3b82f6]"
                      : done
                      ? "bg-white/30 border-white/50 text-white"
                      : "bg-transparent border-white/20 text-white/30"
                  }`}
                >
                  {done ? "✓" : i + 1}
                </div>
                <span
                  className={`mt-1.5 text-xs max-w-[72px] text-center leading-tight ${
                    active ? "text-white font-medium" : done ? "text-white/60" : "text-white/30"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`w-8 h-px mt-[-12px] mx-1 ${done ? "bg-white/40" : "bg-white/15"}`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
