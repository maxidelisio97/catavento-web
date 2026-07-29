import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

interface FieldShellProps {
  label: string;
  htmlFor: string;
  help?: string;
  error?: string;
  children: ReactNode;
}

function FieldShell({ label, htmlFor, help, error, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-panel-700">
        {label}
      </label>
      {children}
      {error ? (
        <span className="text-[11.5px] text-danger-500">{error}</span>
      ) : help ? (
        <span className="text-[11.5px] text-panel-500">{help}</span>
      ) : null}
    </div>
  );
}

const controlClasses =
  "rounded-panel-sm border border-panel-300 bg-white px-2.5 py-1.5 text-[13.5px] text-panel-900 outline-none " +
  "focus:border-accent-500 focus:ring-3 focus:ring-accent-100 disabled:opacity-50";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  help?: string;
  error?: string;
}

export function TextField({ label, help, error, id, className = "", ...props }: TextFieldProps) {
  return (
    <FieldShell label={label} htmlFor={id!} help={help} error={error}>
      <input
        id={id}
        className={[controlClasses, error ? "border-danger-500 focus:ring-danger-50" : "", className].join(" ")}
        {...props}
      />
    </FieldShell>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  help?: string;
  error?: string;
}

export function SelectField({ label, help, error, id, className = "", children, ...props }: SelectFieldProps) {
  return (
    <FieldShell label={label} htmlFor={id!} help={help} error={error}>
      <select id={id} className={[controlClasses, className].join(" ")} {...props}>
        {children}
      </select>
    </FieldShell>
  );
}
