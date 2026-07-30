export interface ProfileSectionLink {
  id: string;
  label: string;
}

export default function ProfileSectionNav({
  label,
  items,
}: {
  label: string;
  items: readonly ProfileSectionLink[];
}) {
  if (items.length < 2) return null;

  return (
    <nav className="profile-section-nav" aria-label={label}>
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
