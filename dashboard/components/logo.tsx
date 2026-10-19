/** The GodsEye mark: the winged eye artwork on a transparent background, in ink for the light panels. */
export function Logo({ size = 48, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo-ink.png" alt="" width={size} height={size} className={`shrink-0 object-contain ${className ?? ""}`} style={{ width: size, height: size }} aria-hidden />
  );
}
