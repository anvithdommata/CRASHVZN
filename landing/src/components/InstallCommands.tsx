import { Check, Copy, Terminal } from "lucide-react";
import { useState } from "react";

const commands = [
  { label: "Clone", value: "git clone https://github.com/anvithdommata/CRASHVZN.git" },
  { label: "Assistant", value: "cd CRASHVZN/packages/assistant && npm install" },
  { label: "App", value: "cd ../../FrontEnd/app && npm install && npm start" },
];

const script = commands.map((command) => command.value).join("\n");

export function InstallCommands() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="install-commands">
      <div className="install-commands-head">
        <span>
          <Terminal size={13} />
          Install from source
        </span>
        <button type="button" className="install-copy" onClick={() => void copy()} aria-label="Copy install commands">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="install-commands-body">
        {commands.map((command) => (
          <code key={command.label}>
            <span className="install-prompt">$</span> {command.value}
          </code>
        ))}
      </pre>
    </div>
  );
}
