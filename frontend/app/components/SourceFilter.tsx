'use client';

interface SourceFilterProps {
  sources: string[];
  selectedSources: string[];
  onChange: (sources: string[]) => void;
}

export function SourceFilter({ sources, selectedSources, onChange }: SourceFilterProps) {
  const toggleSource = (source: string) => {
    if (selectedSources.includes(source)) {
      onChange(selectedSources.filter(s => s !== source));
    } else {
      onChange([...selectedSources, source]);
    }
  };

  if (sources.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 items-center">
      <span className="text-sm font-medium text-slate-400 mr-1">Sources:</span>
      {sources.map(source => {
        const isSelected = selectedSources.includes(source);
        return (
          <button
            key={source}
            onClick={() => toggleSource(source)}
            title={isSelected ? `Hide ${source}` : `Show ${source}`}
            className={`
              px-3 py-1 rounded-full text-xs font-semibold border transition-all duration-200
              ${isSelected
                ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700 shadow-sm'
                : 'bg-white text-slate-400 border-slate-300 hover:border-slate-400 hover:text-slate-600 line-through opacity-60'
              }
            `}
          >
            {source}
          </button>
        );
      })}
    </div>
  );
}
