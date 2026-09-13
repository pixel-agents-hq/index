import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../../../vendor/pixel-agents/webview-ui/src/components/ui/Button.js';
import { useEditorActions } from '../../../../vendor/pixel-agents/webview-ui/src/hooks/useEditorActions.js';
import { useEditorKeyboard } from '../../../../vendor/pixel-agents/webview-ui/src/hooks/useEditorKeyboard.js';
import { OfficeCanvas } from '../../../../vendor/pixel-agents/webview-ui/src/office/components/OfficeCanvas.js';
import { ToolOverlay } from '../../../../vendor/pixel-agents/webview-ui/src/office/components/ToolOverlay.js';
import { EditorState } from '../../../../vendor/pixel-agents/webview-ui/src/office/editor/editorState.js';
import { EditorToolbar } from '../../../../vendor/pixel-agents/webview-ui/src/office/editor/EditorToolbar.js';
import { OfficeState } from '../../../../vendor/pixel-agents/webview-ui/src/office/engine/officeState.js';
import type { LoadedAssetData } from '../../../../vendor/pixel-agents/webview-ui/src/office/layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  serializeLayout,
} from '../../../../vendor/pixel-agents/webview-ui/src/office/layout/layoutSerializer.js';
import { getPetCount } from '../../../../vendor/pixel-agents/webview-ui/src/office/sprites/petSpriteData.js';
import type {
  OfficeLayout,
  ToolActivity,
} from '../../../../vendor/pixel-agents/webview-ui/src/office/types.js';
import {
  EditTool,
  TILE_SIZE,
  TileType,
} from '../../../../vendor/pixel-agents/webview-ui/src/office/types.js';
import { loadLiveOfficeAssets } from './assets';
import { parseInboundLayout } from './inboundLayout';
import {
  isEditOfficeMessage,
  isRenderOfficeMessage,
  LIVE_OFFICE_CHANNEL,
  type MockAgent,
  type ViewerMessage,
} from './protocol';

/**
 * Clicking a character opens that agent's session upstream. There is no session
 * to open here, in either mode — the only callback this frame still has to
 * supply and deliberately not implement.
 */
const noop = () => {
  // Intentionally inert: see above.
};

/**
 * How long editing has to pause before the parent frame is told about it.
 * A paint drag is one `editorTick` per tile, and the parent re-renders its own
 * chrome on every layout it receives; upstream debounces its own layout saves
 * for the same reason (`LAYOUT_SAVE_DEBOUNCE_MS`).
 */
const LAYOUT_POST_DEBOUNCE_MS = 200;

/**
 * Edit mode's one fixed, non-removable mock agent (#121) — previously edit
 * mode showed none at all ("nobody is working in a layout being drawn"), but
 * that left no way for a custom CHARACTER asset to ever appear anywhere:
 * unlike furniture (the palette) and pets (the "active pets" toggle),
 * characters have no placement/toggle affordance in the editor. A single
 * always-present agent gives every editor session one ambient character, and
 * gives the single-asset editor a place to put the one it's inspecting.
 */
const EDIT_MODE_AGENT_ID = 0;

function sendToParent(message: ViewerMessage): void {
  window.parent.postMessage(message, window.location.origin);
}

/**
 * Stamp the revision the parent supplied, never downwards — a layout that
 * already claims a higher one was authored against a newer Pixel Agents than
 * this API pins, and lowering that claim would be this frame inventing a
 * compatibility fact rather than reporting one. See `EditOfficeMessage`.
 */
function withRevision(layout: OfficeLayout, revision: number | undefined): OfficeLayout {
  if (revision === undefined) return layout;
  return { ...layout, layoutRevision: Math.max(layout.layoutRevision ?? 0, revision) };
}

function applyAgents(office: OfficeState, agents: MockAgent[]): void {
  const desired = new Set(agents.map((agent) => agent.id));
  for (const [id, character] of office.characters) {
    if (!character.isSubagent && !desired.has(id)) office.removeAgent(id);
  }

  for (const agent of agents) {
    office.addAgent(agent.id);
    office.setAgentActive(agent.id, true);
    office.setAgentTool(agent.id, agent.tool);
  }
}

function toolRows(agents: MockAgent[]): Record<number, ToolActivity[]> {
  return Object.fromEntries(
    agents.map((agent) => [
      agent.id,
      [
        {
          toolId: `pixel-index-mock-${agent.id}`,
          status: agent.activity,
          done: false,
          permissionWait: false,
        },
      ],
    ]),
  );
}

/**
 * The bounding box of every non-VOID tile — the frame the camera fits to.
 *
 * Deliberately a private copy of `occupiedBounds()` in
 * `@pixel-index/layout-core` (same algorithm, same fallback for an
 * entirely-VOID layout), not an import of it: that package's barrel also
 * re-exports `schemas.ts`/`upstream.ts`, which read the filesystem and shell
 * out to git at module scope for the CLI/server use cases. Without a
 * `"sideEffects": false` in its package.json, a bundler cannot prove those
 * are safe to drop, so importing anything from the package pulls `node:fs`,
 * `node:child_process` and `node:url` into this browser bundle — Vite
 * externalizes them, and the first real call (`fileURLToPath`) throws at
 * runtime and blanks the live preview. If `#55` needs to be revisited, keep
 * this in sync with `occupiedBounds()` by hand rather than importing it.
 */
function visibleTileBounds(layout: OfficeLayout): {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
} {
  let minCol = layout.cols;
  let maxCol = -1;
  let minRow = layout.rows;
  let maxRow = -1;

  for (let row = 0; row < layout.rows; row += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      // No `tile === undefined` check: parseInboundLayout has already pinned
      // tiles.length to cols * rows, so every index this loop visits exists.
      const tile = layout.tiles[row * layout.cols + col];
      if (tile === TileType.VOID) continue;
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
    }
  }

  return maxCol >= 0
    ? { minCol, maxCol, minRow, maxRow }
    : { minCol: 0, maxCol: layout.cols - 1, minRow: 0, maxRow: layout.rows - 1 };
}

/**
 * The live office, in one of two modes decided entirely by which message the
 * parent frame sends first: `render` (read-only, a layout page's preview) or
 * `edit` (#65, the editor behind `/editor`).
 *
 * Everything the editor does comes from upstream — `useEditorActions` is the
 * whole controller, `EditorToolbar` the whole palette. What this frame adds is
 * the two things upstream cannot know about: where the layout came from, and
 * where it goes (back to the parent, over `protocol.ts`). Upstream's own
 * `saveLayout` transport call is aliased away to an inert transport at build
 * time (`build/liveOfficeAssets.ts`), so the layout only ever leaves here by
 * the `layout` message below.
 */
export function PreviewApp() {
  const office = useMemo(() => new OfficeState(), []);
  const editorState = useMemo(() => new EditorState(), []);
  const getOfficeState = useCallback(() => office, [office]);
  const editor = useEditorActions(getOfficeState, editorState);
  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(() => Math.max(1, Math.round(2 * window.devicePixelRatio)));
  const [assets, setAssets] = useState<(LoadedAssetData & { characterPaletteIndex?: number }) | null>(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [agents, setAgents] = useState<MockAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The editor mutates `editorState` imperatively (upstream's design), so tool
  // changes made from the keyboard need a render nudge the same way App.tsx's do.
  const [, bumpKeyboardTick] = useState(0);
  /** The last layout the parent was told about — what makes re-posting a no-op edit cheap. */
  const lastPosted = useRef<string | null>(null);
  /**
   * Re-applied on the way out as well as on the way in: upstream's edit
   * actions all rebuild the layout by spreading it, so the field does survive
   * an edit — but that is upstream's implementation detail, and the stamp is
   * this frame's promise.
   */
  const revisionRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // A controller for the honest `boolean`, not for cancellation: this page
    // mounts once, outside StrictMode (live-office/main.tsx), and never
    // unmounts, so threading a signal into loadLiveOfficeAssets' seven fetches
    // would buy nothing real.
    const controller = new AbortController();
    // The frame is a separate document from the parent page (`live-office.html`),
    // so the single-asset editor's asset id crosses in on the frame's own URL
    // rather than through the postMessage protocol — see LayoutEditorPage.tsx's
    // iframe `src`.
    const assetId = new URLSearchParams(window.location.search).get('asset');
    loadLiveOfficeAssets(assetId)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setAssets(loaded);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : 'Could not load the live office.';
        setError(message);
        sendToParent({ channel: LIVE_OFFICE_CHANNEL, type: 'error', message });
      });
    return () => {
      controller.abort();
    };
  }, []);

  /** Frame the camera on the layout's occupied tiles, at the largest zoom that fits. */
  const fitCamera = useCallback((layout: OfficeLayout) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const dpr = window.devicePixelRatio || 1;
    const visible = visibleTileBounds(layout);
    const visibleCols = visible.maxCol - visible.minCol + 1;
    const visibleRows = visible.maxRow - visible.minRow + 1;
    const fit = Math.floor(
      Math.min(
        (bounds.width * dpr) / ((visibleCols + 2) * TILE_SIZE),
        (bounds.height * dpr) / ((visibleRows + 2) * TILE_SIZE),
      ),
    );
    const nextZoom = Math.max(1, Math.min(Math.round(2 * dpr), fit));
    const visibleCenterCol = (visible.minCol + visible.maxCol + 1) / 2;
    const visibleCenterRow = (visible.minRow + visible.maxRow + 1) / 2;
    panRef.current = {
      x: (layout.cols / 2 - visibleCenterCol) * TILE_SIZE * nextZoom,
      y: (layout.rows / 2 - visibleCenterRow) * TILE_SIZE * nextZoom,
    };
    setZoom(nextZoom);
  }, []);

  const setLastSavedLayout = editor.setLastSavedLayout;

  useEffect(() => {
    if (!assets) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      try {
        // Checked rather than asserted — see inboundLayout.ts. A layout that
        // fails throws, and the catch below reports it to the parent frame on
        // the path that already exists for a render failure.
        if (isEditOfficeMessage(data)) {
          revisionRef.current = data.layoutRevision;
          const layout = withRevision(
            data.layout === null ? createDefaultLayout() : parseInboundLayout(data.layout),
            data.layoutRevision,
          );
          office.rebuildFromLayout(layout);
          fitCamera(layout);
          // The baseline "Revert" returns to.
          setLastSavedLayout(layout);
          // Posted straight back rather than assumed: for a blank layout the
          // parent has never seen these bytes, and for every other case it is
          // this frame — not the parent — that decides what the migrated,
          // revision-stamped document is. One producer, no divergence.
          const serialized = serializeLayout(layout);
          lastPosted.current = serialized;
          sendToParent({ channel: LIVE_OFFICE_CHANNEL, type: 'layout', layout: serialized });
          // One fixed, non-removable mock agent (#121, EDIT_MODE_AGENT_ID) —
          // not the read-only preview's adjustable `agents` list.
          // `rebuildFromLayout` above never touches `office.characters`, so
          // this agent survives every subsequent `edit` message (e.g.
          // re-importing a layout.json) untouched; `addAgent` is also
          // idempotent (no-ops if the id already exists), so calling it again
          // here on every message is harmless either way. Forcing
          // `characterPaletteIndex` (set only when the single-asset editor is
          // inspecting a custom character) is what makes that character the
          // one this agent wears, instead of a random built-in.
          office.addAgent(EDIT_MODE_AGENT_ID, assets.characterPaletteIndex);
          setAgents([]);
          setEditing(true);
        } else if (isRenderOfficeMessage(data)) {
          const layout = parseInboundLayout(data.layout);
          office.rebuildFromLayout(layout);
          fitCamera(layout);
          applyAgents(office, data.agents);
          setAgents(data.agents);
        } else {
          return;
        }
        setError(null);
        setLayoutReady(true);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : 'Could not render this layout.';
        setError(message);
        sendToParent({ channel: LIVE_OFFICE_CHANNEL, type: 'error', message });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [assets, office, fitCamera, setLastSavedLayout]);

  // Upstream's edit mode is a toggle, and this frame's is a destination: once
  // the parent asks for an editor, there is nothing here to toggle back to.
  // Guarded on `isEditMode` rather than run once, because the toggle is what
  // seeds the wall colour from the layout's existing walls.
  const { isEditMode, handleToggleEditMode } = editor;
  useEffect(() => {
    if (editing && !isEditMode) handleToggleEditMode();
  }, [editing, isEditMode, handleToggleEditMode]);

  // Every edit reaches the parent, debounced — there is no separate "save"
  // inside this frame. The parent owns publishing, so it has to hold the
  // current bytes at all times, not only when someone remembers to press save.
  const { editorTick } = editor;
  useEffect(() => {
    if (!editing) return;
    const timer = setTimeout(() => {
      const serialized = serializeLayout(withRevision(office.getLayout(), revisionRef.current));
      // `editorTick` also bumps for selection changes, which move no tiles.
      if (serialized === lastPosted.current) return;
      lastPosted.current = serialized;
      sendToParent({ channel: LIVE_OFFICE_CHANNEL, type: 'layout', layout: serialized });
    }, LAYOUT_POST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [editing, editorTick, office]);

  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => bumpKeyboardTick((n) => n + 1), []),
    // Upstream's last Escape leaves edit mode. Here that would strand the
    // visitor in a read-only canvas on a page whose whole purpose is editing.
    noop,
  );

  // Announce readiness only after the message listener above is attached. This
  // prevents the parent from posting the first layout into a listener gap.
  useEffect(() => {
    if (assets) sendToParent({ channel: LIVE_OFFICE_CHANNEL, type: 'ready' });
  }, [assets]);

  const isEditingAreas = editor.isEditMode && editorState.activeTool === EditTool.AREA_PAINT;
  const selectedFurnitureColor = editorState.selectedFurnitureUid
    ? (office.getLayout().furniture.find((item) => item.uid === editorState.selectedFurnitureUid)
        ?.color ?? null)
    : null;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {error ? (
        <p className="viewer-message">{error}</p>
      ) : layoutReady ? (
        <>
          <OfficeCanvas
            officeState={office}
            onClick={noop}
            isEditMode={editor.isEditMode}
            editorState={editorState}
            onEditorTileAction={editor.handleEditorTileAction}
            onEditorEraseAction={editor.handleEditorEraseAction}
            onEditorSelectionChange={editor.handleEditorSelectionChange}
            onDeleteSelected={editor.handleDeleteSelected}
            onRotateSelected={editor.handleRotateSelected}
            onDragMove={editor.handleDragMove}
            editorTick={editor.editorTick}
            zoom={zoom}
            onZoomChange={setZoom}
            panRef={panRef}
            // In view mode the areas overlay stays off, as it always has: a
            // layout page shows the office, not its editing metadata.
            showAreas={isEditingAreas}
            activeAreaLabel={isEditingAreas ? editor.selectedAreaLabel : null}
          />
          {editor.isEditMode && (
            <>
              <div className="pixel-panel absolute top-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-4 p-4">
                <Button
                  variant={editorState.undoStack.length === 0 ? 'disabled' : 'default'}
                  size="md"
                  onClick={editorState.undoStack.length === 0 ? undefined : editor.handleUndo}
                  title="Undo (Ctrl+Z)"
                >
                  Undo
                </Button>
                <Button
                  variant={editorState.redoStack.length === 0 ? 'disabled' : 'default'}
                  size="md"
                  onClick={editorState.redoStack.length === 0 ? undefined : editor.handleRedo}
                  title="Redo (Ctrl+Shift+Z)"
                >
                  Redo
                </Button>
                <Button
                  variant={editor.isDirty ? 'default' : 'disabled'}
                  size="md"
                  onClick={editor.isDirty ? editor.handleReset : undefined}
                  title="Discard every change back to the layout this editor opened with"
                >
                  Revert
                </Button>
              </div>
              <EditorToolbar
                activeTool={editorState.activeTool}
                selectedTileType={editorState.selectedTileType}
                selectedFurnitureType={editorState.selectedFurnitureType}
                selectedFurnitureUid={editorState.selectedFurnitureUid}
                selectedFurnitureColor={selectedFurnitureColor}
                floorColor={editorState.floorColor}
                wallColor={editorState.wallColor}
                selectedWallSet={editorState.selectedWallSet}
                onToolChange={editor.handleToolChange}
                onTileTypeChange={editor.handleTileTypeChange}
                onFloorColorChange={editor.handleFloorColorChange}
                onWallColorChange={editor.handleWallColorChange}
                onWallSetChange={editor.handleWallSetChange}
                onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                pickedFurnitureColor={editorState.pickedFurnitureColor}
                onPickedFurnitureColorChange={editor.handlePickedFurnitureColorChange}
                onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                {...(assets ? { loadedAssets: assets } : {})}
                activePetTypes={office.getActivePetTypes()}
                petCount={getPetCount()}
                onPetToggle={editor.handlePetToggle}
                carpetVariant={editor.carpetVariant}
                carpetColor={editor.carpetColor}
                carpetAccentColor={editor.carpetAccentColor}
                onCarpetVariantChange={editor.handleCarpetVariantChange}
                onCarpetColorChange={editor.handleCarpetColorChange}
                onCarpetAccentColorChange={editor.handleCarpetAccentColorChange}
                areas={office.getLayout().areas ?? []}
                selectedAreaLabel={editor.selectedAreaLabel}
                onSelectArea={editor.handleSelectArea}
                onAddArea={editor.handleAddArea}
                onRemoveArea={editor.handleRemoveArea}
                onRenameArea={editor.handleRenameArea}
                onAreaColorChange={editor.handleAreaColorChange}
                // Areas map to VS Code workspace folders upstream. A layout in
                // the index has no workspace, so the tool stays available (areas
                // are part of layout.json) but the mapping half of it is empty.
                workspaceFolders={[]}
                areasAvailable
                areaMappings={{}}
                onAreaMappingChange={noop}
              />
            </>
          )}
          <ToolOverlay
            officeState={office}
            agents={agents.map((agent) => agent.id)}
            agentTools={toolRows(agents)}
            subagentTools={{}}
            subagentCharacters={[]}
            containerRef={containerRef}
            zoom={zoom}
            panRef={panRef}
            onCloseAgent={(id) =>
              sendToParent({ channel: LIVE_OFFICE_CHANNEL, type: 'remove-agent', id })
            }
            alwaysShowOverlay
          />
        </>
      ) : (
        <p className="viewer-message">Loading live office…</p>
      )}
    </div>
  );
}
