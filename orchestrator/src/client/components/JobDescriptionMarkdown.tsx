import type React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface JobDescriptionMarkdownProps {
  className?: string;
  description: string;
}

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const getSafeHref = (href?: string) => {
  if (!href) return undefined;

  try {
    const url = new URL(href, "https://cvclanker.local");
    if (
      url.origin === "https://cvclanker.local" &&
      !href.startsWith("http://") &&
      !href.startsWith("https://") &&
      !href.startsWith("mailto:")
    ) {
      return undefined;
    }

    return SAFE_PROTOCOLS.has(url.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
};

export const JobDescriptionMarkdown: React.FC<JobDescriptionMarkdownProps> = ({
  className,
  description,
}) => {
  return (
    <div
      className={
        className ??
        "text-sm leading-relaxed text-foreground [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold [&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-background [&_pre]:p-3 [&_code]:rounded [&_code]:bg-background/80 [&_code]:px-1 [&_code]:py-0.5 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-primary [&_a]:underline"
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: () => null,
          a: ({ children, href, ...props }) => {
            const safeHref = getSafeHref(href);
            if (!safeHref) return <span>{children}</span>;

            return (
              <a
                {...props}
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {description}
      </ReactMarkdown>
    </div>
  );
};
