"use client";
import { useEffect, useRef, useState } from "react";

interface Step {
  label: string;
}

interface Props {
  steps: Step[];
  currentStep: number;
}

export default function Timeline({ steps, currentStep }: Props) {
  const popKey = usePopKey(currentStep);
  return (
    <div className="overlay-enter bg-black/70 backdrop-blur-md border border-white/20 rounded-xl px-5 py-3">
      <div className="flex items-center gap-0">
        {steps.map((step, i) => {
          const active = i === currentStep;
          const done = i < currentStep;
          return (
            <div key={i} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  key={active ? `active-${popKey}` : `dot-${i}`}
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors duration-300 ${
                    active
                      ? "bg-blue-500 border-blue-400 text-white shadow-[0_0_12px_#3b82f6] step-pop"
                      : done
                      ? "bg-white/30 border-white/50 text-white"
                      : "bg-transparent border-white/20 text-white/30"
                  }`}
                >
                  {done ? "✓" : i + 1}
                </div>
                <span
                  className={`mt-1.5 text-xs max-w-[72px] text-center leading-tight transition-colors duration-300 ${
                    active ? "text-white font-medium" : done ? "text-white/60" : "text-white/30"
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`w-8 h-px mt-[-12px] mx-1 transition-colors duration-300 ${
                    done ? "bg-white/40" : "bg-white/15"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function usePopKey(currentStep: number): number {
  const [key, setKey] = useState(0);
  const prevRef = useRef(currentStep);
  useEffect(() => {
    if (prevRef.current !== currentStep) {
      prevRef.current = currentStep;
      setKey((k) => k + 1);
    }
  }, [currentStep]);
  return key;
}
