import { CardGrid, Tile } from '@/components/ui/Card'

export default function HomePage() {
  return (
    <CardGrid>
      <Tile href="/design" icon="swatch" title="Design" tone="gray" />
    </CardGrid>
  )
}
