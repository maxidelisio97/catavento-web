export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-panel-100 text-panel-600",
  accent: "bg-accent-50 text-accent-700",
  success: "bg-success-50 text-success-700",
  warning: "bg-warning-50 text-warning-700",
  danger: "bg-danger-50 text-danger-700",
};

const DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-panel-400",
  accent: "bg-accent-500",
  success: "bg-success-500",
  warning: "bg-warning-500",
  danger: "bg-danger-500",
};

interface BadgeProps {
  tone: BadgeTone;
  children: React.ReactNode;
}

export default function Badge({ tone, children }: BadgeProps) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold leading-[1.4]",
        TONE_CLASSES[tone],
      ].join(" ")}
    >
      <span className={["h-1.5 w-1.5 rounded-full", DOT_CLASSES[tone]].join(" ")} />
      {children}
    </span>
  );
}
