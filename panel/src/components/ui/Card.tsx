import type { ElementType, ComponentPropsWithoutRef } from "react";

type CardProps<T extends ElementType> = { as?: T; className?: string } & Omit<
  ComponentPropsWithoutRef<T>,
  "as" | "className"
>;

export default function Card<T extends ElementType = "div">({
  as,
  className = "",
  ...props
}: CardProps<T>) {
  const Tag = as ?? "div";
  return (
    <Tag
      className={["bg-white border border-panel-200 rounded-panel-md shadow-panel-xs", className].join(" ")}
      {...props}
    />
  );
}
