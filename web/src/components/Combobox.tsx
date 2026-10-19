import { useId, useState, type KeyboardEvent } from 'react';

interface Props {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}

/**
 * Text input with a filtered suggestion list, following the WAI-ARIA combobox pattern.
 * Built by hand rather than with <datalist>, whose dropdown some browsers (Safari, embedded
 * webviews) don't render. Free typing still works: suggestions only help.
 */
export function Combobox({ label, placeholder, value, onChange, options }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const query = value.trim().toLowerCase();
  const matches = query ? options.filter((o) => o.toLowerCase().includes(query)) : options;
  const showList = open && (query !== '' || activeIndex >= 0);
  const optionId = (index: number) => `${listId}-option-${index}`;

  function select(option: string) {
    onChange(option);
    setOpen(false);
    setActiveIndex(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOpen(true);
        setActiveIndex((i) => (matches.length === 0 ? -1 : (i + 1) % matches.length));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setOpen(true);
        setActiveIndex((i) =>
          matches.length === 0 ? -1 : (i - 1 + matches.length) % matches.length,
        );
        break;
      case 'Enter': {
        const active = showList ? matches[activeIndex] : undefined;
        if (active !== undefined) {
          // Pick the highlighted suggestion instead of submitting the form.
          event.preventDefault();
          select(active);
        }
        break;
      }
      case 'Escape':
        setOpen(false);
        setActiveIndex(-1);
        break;
    }
  }

  return (
    <div className="combobox">
      <input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActiveIndex(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="combobox-list"
        >
          {matches.map((option, index) => (
            <li
              key={option}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? 'active' : undefined}
              // mousedown, not click: it fires before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                select(option);
              }}
            >
              {option}
            </li>
          ))}
          {matches.length === 0 && (
            <li className="combobox-empty" aria-disabled="true">
              No untracked competitor matches “{value.trim()}”
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
