import { forwardRef } from "react";
import Link from "next/link";

type Variant =
  | "primary"
  | "secondary"
  | "destructive"
  | "ghost"
  /** Neutral-but-prominent action, e.g. Export PDF. Never red — red means destructive. */
  | "accent";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-blue-600 text-white hover:bg-blue-700 focus-visible:ring-blue-500",
  accent:
    "bg-slate-700 text-white hover:bg-slate-800 dark:bg-slate-600 dark:hover:bg-slate-500 focus-visible:ring-slate-500",
  secondary:
    "bg-gray-200 text-gray-900 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600 focus-visible:ring-gray-500",
  destructive:
    "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500",
  ghost:
    "bg-transparent text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 focus-visible:ring-blue-500",
};

const SIZES: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

const BASE =
  "inline-flex items-center justify-center gap-2 text-center whitespace-nowrap rounded-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-900 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The shared button class string.
 *
 * Exported so anchors and `next/link` can be styled identically to a
 * `<button>`. That parity matters: a bare `<a>` inherits `text-align: start`
 * while a `<button>` gets `center` from the UA stylesheet, so two visually
 * identical full-width controls used to align their labels differently on
 * mobile. `justify-center` here makes the element type irrelevant.
 */
export function buttonClasses(
  variant: Variant = "primary",
  size: Size = "md",
  className = "",
): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`;
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/**
 * Consistent button styling across the app. Consolidates the many inline
 * Tailwind button colors/paddings into a small set of variants + sizes.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", type, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={buttonClasses(variant, size, className)}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

export interface ButtonLinkProps
  extends Omit<React.ComponentPropsWithoutRef<typeof Link>, "className"> {
  variant?: Variant;
  size?: Size;
  className?: string;
}

/**
 * A `next/link` that looks and aligns exactly like `<Button>`. Use this for
 * navigation actions ("Add Expense", "Create Report") so they stay visually
 * identical to real buttons beside them.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  ({ variant = "primary", size = "md", className = "", ...props }, ref) => {
    return (
      <Link
        ref={ref}
        className={buttonClasses(variant, size, className)}
        {...props}
      />
    );
  },
);

ButtonLink.displayName = "ButtonLink";
