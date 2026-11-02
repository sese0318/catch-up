// Small shared building blocks. Real buttons and inputs only, 44 px targets, lang on text.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { copyText, ownerWindowOf } from "@/lib/client/clipboard";
import { cutToWidthUnits } from "@/lib/client/format";
import { UI } from "@/lib/client/copy";
import { CheckIcon, CopyIcon } from "./icons";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function VisuallyHidden({ children, lang }: { children: ReactNode; lang?: string }) {
  return (
    <span className="sr-only" lang={lang}>
      {children}
    </span>
  );
}

type CopyState = "idle" | "copied" | "failed";

/** A copy button that says Copied for 2 seconds and tells screen readers once. */
export function CopyButton({
  text,
  label,
  className,
  compact = false,
}: {
  text: string;
  label: string;
  className?: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    const ok = await copyText(text, ownerWindowOf(event.currentTarget));
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2_000);
  };

  const shown = state === "copied" ? UI.copied : state === "failed" ? UI.copyFailed : label;
  return (
    <>
      <button
        type="button"
        className={cx("cu-btn cu-btn-quiet", compact && "cu-btn-small", className)}
        onClick={onClick}
        lang="en"
        aria-label={label}
      >
        {state === "copied" ? <CheckIcon aria-hidden="true" weight="bold" /> : <CopyIcon aria-hidden="true" />}
        <span>{shown}</span>
      </button>
      <span className="sr-only" role="status" lang="en">
        {state === "idle" ? "" : shown}
      </span>
    </>
  );
}

export interface ChipOption<T extends string | number> {
  value: T;
  label: string;
  lang?: string;
  disabled?: boolean;
  hint?: string;
}

/** A row of radio chips (window, languages, text size). Arrow keys move between them. */
export function RadioChips<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  hideLegend = false,
  className,
  big = false,
}: {
  legend: string;
  options: readonly ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  hideLegend?: boolean;
  className?: string;
  big?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className={cx("cu-chips", big && "cu-chips-big", className)}>
      <legend className={hideLegend ? "sr-only" : "cu-legend"} lang="en">
        {legend}
      </legend>
      <div className="cu-chips-row">
        {options.map((option) => (
          <label key={String(option.value)} className="cu-chip" data-disabled={option.disabled || undefined}>
            <input
              type="radio"
              name={name}
              value={String(option.value)}
              checked={option.value === value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span lang={option.lang ?? "en"}>{option.label}</span>
            {option.hint ? (
              <span className="cu-chip-hint" lang="en">
                {option.hint}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export type NoticeTone = "info" | "warn" | "error";

export function Notice({
  tone = "info",
  icon,
  children,
  actions,
  lang = "en",
}: {
  tone?: NoticeTone;
  icon?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  lang?: string;
}) {
  return (
    <div className="cu-notice" data-tone={tone} lang={lang}>
      {icon ? <span className="cu-notice-icon">{icon}</span> : null}
      <div className="cu-notice-body">
        <div className="cu-notice-text">{children}</div>
        {actions ? <div className="cu-notice-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/** A text input that caps its width units, but leaves an IME alone until the word is committed. */
export function CappedInput({
  id,
  value,
  cap,
  onValue,
  placeholder,
  describedBy,
  label,
  hideLabel = false,
}: {
  id: string;
  value: string;
  cap: number;
  onValue: (value: string) => void;
  placeholder?: string;
  describedBy?: string;
  label: string;
  hideLabel?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "cu-label"} lang="en">
        {label}
      </label>
      <input
        id={id}
        type="text"
        className="cu-input"
        value={draft ?? value}
        placeholder={placeholder}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        onCompositionStart={(e) => setDraft(e.currentTarget.value)}
        onCompositionEnd={(e) => {
          setDraft(null);
          onValue(cutToWidthUnits(e.currentTarget.value, cap));
        }}
        onChange={(e) => {
          if (draft !== null) setDraft(e.target.value);
          else onValue(cutToWidthUnits(e.target.value, cap));
        }}
      />
    </>
  );
}
