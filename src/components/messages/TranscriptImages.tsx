import React from 'react'
import { Box, Image, Text, useTerminalImages, useTerminalSize } from '../../ui.js'
import type { TerminalImageSource } from '../../ink/terminal-image.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { makeDecodeTier } from './transcriptImageDecode.js'
import { cleanRenderText } from '../../dsh-adapter/sanitize.js'
import { getLang, subscribeLang, t } from '../../i18n.js'

const thumbnailTier = makeDecodeTier(384, 24)

/** Bounded image gallery shared by user, assistant, and tool-result rows. */
export function TranscriptImages({
  images,
  indent = 2,
}: {
  readonly images: readonly TranscriptImage[]
  readonly indent?: number
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const graphicsAvailable = useTerminalImages(images.length > 0)
  React.useSyncExternalStore(subscribeLang, getLang)
  if (images.length === 0) return null
  const available = Math.max(1, columns - indent - 3)
  return (
    <Box
      flexDirection="row"
      flexWrap="wrap"
      gap={1}
      paddingLeft={indent}
      width="100%"
    >
      {images.map((image, index) => {
        const [width, height] = previewSize(image, images.length, available)
        return (
          <TranscriptImagePreview
            key={`${image.id}:${index}`}
            image={image}
            width={width}
            height={height}
            graphicsAvailable={graphicsAvailable}
          />
        )
      })}
    </Box>
  )
}

function TranscriptImagePreview({
  image,
  width,
  height,
  graphicsAvailable,
}: {
  readonly image: TranscriptImage
  readonly width: number
  readonly height: number
  readonly graphicsAvailable: boolean
}): React.ReactNode {
  const [state, setState] = React.useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly source: TerminalImageSource }
    | { readonly kind: 'failed' }
  >({ kind: 'loading' })

  React.useEffect(() => {
    if (!graphicsAvailable) return
    let live = true
    const controller = new AbortController()
    setState({ kind: 'loading' })
    void thumbnailTier.load(image, controller.signal).then(
      source => { if (live) setState({ kind: 'ready', source }) },
      () => { if (live) setState({ kind: 'failed' }) },
    )
    return () => { live = false; controller.abort() }
  }, [image, graphicsAvailable])

  const label = cleanRenderText(image.name ?? '', 80) || t('transcript-image')
  const fallback = !graphicsAvailable
    ? t('transcript-image-ready', { name: label })
    : state.kind === 'failed'
      ? t('transcript-image-unavailable', { name: label })
      : state.kind === 'loading'
        ? t('transcript-image-loading', { name: label })
        : t('transcript-image-ready', { name: label })
  return (
    <Image
      source={graphicsAvailable && state.kind === 'ready' ? state.source : undefined}
      width={width}
      height={height}
      alt={label}
    >
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Text dimColor wrap="truncate">[{fallback}]</Text>
      </Box>
    </Image>
  )
}

function previewSize(
  image: TranscriptImage,
  count: number,
  available: number,
): readonly [number, number] {
  if (count > 1) {
    const width = Math.max(1, Math.min(10, available))
    return [width, Math.max(1, Math.round(width / 2))]
  }
  const ratio = Math.max(0.25, Math.min(4, image.width / image.height))
  const maxWidth = Math.max(1, Math.min(24, available))
  const maxHeight = 12
  let width = maxWidth
  let height = Math.max(1, Math.round(width / (2 * ratio)))
  if (height > maxHeight) {
    height = maxHeight
    width = Math.max(1, Math.min(maxWidth, Math.round(2 * height * ratio)))
  }
  return [width, height]
}

/** @internal Focused regression scripts clear the process-local LRU. */
export function clearTranscriptImageCacheForTests(): void {
  thumbnailTier.clear()
}
