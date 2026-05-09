"use client";

interface Props {
  enabled: boolean;
}

export default function Letterbox({ enabled }: Props) {
  if (!enabled) return null;
  return (
    <>
      <div className="letterbox-enter-top absolute top-0 left-0 right-0 h-[11vh] bg-black z-20" />
      <div className="letterbox-enter-bottom absolute bottom-0 left-0 right-0 h-[11vh] bg-black z-20" />
    </>
  );
}
