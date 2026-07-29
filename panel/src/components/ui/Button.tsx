import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "md" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent-500 text-white hover:bg-accent-600 focus-visible:ring-accent-200",
  secondary:
    "bg-white text-panel-800 border border-panel-300 hover:bg-panel-100 hover:border-panel-400 focus-visible:ring-accent-200",
  ghost: "bg-transparent text-panel-700 hover:bg-panel-100 focus-visible:ring-accent-200",
  danger: "bg-danger-500 text-white hover:bg-danger-700 focus-visible:ring-danger-50",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "px-3.5 py-1.5 text-[13.5px]",
  sm: "px-2.5 py-1 text-xs",
};

export default function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        "inline-flex items-center gap-1.5 rounded-panel-sm font-medium transition-colors",
        "disabled:opacity-45 disabled:cursor-not-allowed",
        "focus-visible:outline-none focus-visible:ring-3",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      ].join(" ")}
      {...props}
    />
  );
}
