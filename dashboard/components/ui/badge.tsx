import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider", {
  variants: {
    variant: {
      default: "border-border bg-muted text-foreground",
      win: "border-win/40 bg-win/10 text-win",
      loss: "border-loss/40 bg-loss/10 text-loss",
      amber: "border-amber/40 bg-amber/10 text-amber",
      outline: "border-border text-muted-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
