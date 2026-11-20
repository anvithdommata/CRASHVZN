import { Wordmark } from "@/components/Brand";
import { DownloadButton } from "@/components/DownloadButton";
import { useScrolled } from "@/lib/hooks";
import { Github, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";

const links = [
  { label: "Workflow", href: "#workflow" },
  { label: "Assistant", href: "#assistant" },
  { label: "Download", href: "#download" },
  { label: "FAQ", href: "#faq" },
];

export function Nav() {
  useScrolled();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.body.classList.toggle("menu-open", open);
    return () => document.body.classList.remove("menu-open");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <header className="site-nav">
        <div className="container-x nav-inner">
          <a href="#top" className="nav-brand" aria-label="CRASHVZN home">
            <Wordmark />
          </a>

          <nav className="nav-links" aria-label="Primary navigation">
            {links.map((link) => (
              <a key={link.href} href={link.href} className="nav-link">
                {link.label}
              </a>
            ))}
          </nav>

          <div className="nav-actions">
            <a
              className="nav-github"
              href="https://github.com/anvithdommata/CRASHVZN"
              target="_blank"
              rel="noreferrer"
              aria-label="CRASHVZN on GitHub"
            >
              <Github size={16} />
              <span>GitHub</span>
            </a>
            <DownloadButton compact label="Download" />
            <button
              type="button"
              className="nav-menu-button"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              aria-controls="mobile-menu"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </header>

      <div id="mobile-menu" className={`mobile-menu ${open ? "is-open" : ""}`} aria-hidden={!open} inert={!open}>
        <nav aria-label="Mobile navigation">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="mobile-menu-footer">
          <DownloadButton className="w-full" />
          <a
            className="nav-github"
            href="https://github.com/anvithdommata/CRASHVZN"
            target="_blank"
            rel="noreferrer"
          >
            <Github size={16} /> View source on GitHub
          </a>
        </div>
      </div>
    </>
  );
}
