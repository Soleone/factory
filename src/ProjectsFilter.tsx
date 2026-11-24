import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { repoName } from "@/format";

export function ProjectsFilter({
  projects,
  project,
  onProjectChange,
}: {
  projects: readonly string[];
  project: string | null;
  onProjectChange: (project: string | null) => void;
}) {
  const paths = new Set(projects);
  // A project picked in another view (or since removed) must still be possible to clear.
  if (project !== null) paths.add(project);
  const options = [
    { value: null, label: "All projects" },
    ...[...paths]
      .map((path) => ({ value: path, label: repoName(path) }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)),
  ];

  return (
    <Select items={options} value={project} onValueChange={onProjectChange}>
      <SelectTrigger aria-label="Projects" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {options.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
