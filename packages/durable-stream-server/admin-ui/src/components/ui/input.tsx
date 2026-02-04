import * as React from "react";
import { cn } from "../../lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-lg border border-surface-200 bg-white px-3 py-2 text-sm text-surface-900 shadow-sm transition-colors",
          "placeholder:text-surface-400",
          "focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-400/20",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
