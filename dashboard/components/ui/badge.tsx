import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("tag", {
  variants: {
    variant: {
      default: "",
      win: "bg-lilac text-ink",
      loss: "bg-[#F1DCE3] text-loss",
      amber: "bg-frame text-white",
      outline: "bg-transparent text-muted-foreground ring-1 ring-inset ring-chip",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
