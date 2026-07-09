import { useEffect, useRef, useState } from "react";

export function useIntersectionObserver<T extends Element>() {
  const elementRef = useRef<T | null>(null);
  const [isVisible, setVisible] = useState(false);

  useEffect(() => {
    if (!elementRef.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.3,
    });
    observer.observe(elementRef.current);
    return () => observer.disconnect();
  }, []);

  return { elementRef, isVisible } as const;
}
