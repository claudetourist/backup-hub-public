import { useId, type ReactNode } from 'react';

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  /** Short help under the field. */
  hint?: ReactNode;
  /** Plain-language problem; shown in place of the hint. */
  error?: string | null;
  disabled?: boolean;
  maxLength?: number;
  autoComplete?: 'off' | 'new-password' | 'current-password';
  autoFocus?: boolean;
  /** Marks this as the Files search box, so Ctrl+K can put the cursor here from any screen. */
  searchBox?: boolean;
  onEnter?: () => void;
}

/** A labelled text box. The label is a real <label>, so the whole field is reachable by keyboard and screen reader. */
export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  error,
  disabled = false,
  maxLength,
  autoComplete = 'off',
  autoFocus = false,
  searchBox = false,
  onEnter,
}: TextFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const hasNote = Boolean(error) || Boolean(hint);
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field__input"
        type={type}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        data-search-box={searchBox ? 'true' : undefined}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={hasNote ? noteId : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={
          onEnter
            ? (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onEnter();
                }
              }
            : undefined
        }
      />
      {hasNote ? (
        <span id={noteId} className={error ? 'field__note tone-text tone-text--crit' : 'field__note'} role={error ? 'alert' : undefined}>
          {error ?? hint}
        </span>
      ) : null}
    </div>
  );
}
