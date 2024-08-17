/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import { Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { TwoKeyMap } from 'vs/base/common/map';
import type { IBoundingBox, IReadableTextureAtlasPage, ITextureAtlasAllocator, ITextureAtlasGlyph } from 'vs/editor/browser/view/gpu/atlas/atlas';
import { TextureAtlasShelfAllocator } from 'vs/editor/browser/view/gpu/atlas/textureAtlasShelfAllocator';
import { TextureAtlasSlabAllocator } from 'vs/editor/browser/view/gpu/atlas/textureAtlasSlabAllocator';
import type { GlyphRasterizer } from 'vs/editor/browser/view/gpu/raster/glyphRasterizer';
import { ILogService, LogLevel } from 'vs/platform/log/common/log';
import { IThemeService } from 'vs/platform/theme/common/themeService';

export class TextureAtlasPage extends Disposable implements IReadableTextureAtlasPage {
	private _version: number = 0;

	private _usedArea: IBoundingBox = { left: 0, top: 0, right: 0, bottom: 0 };
	public get usedArea(): Readonly<IBoundingBox> {
		return this._usedArea;
	}

	/**
	 * The version of the texture atlas. This is incremented every time the page's texture changes.
	 */
	get version(): number {
		return this._version;
	}

	private readonly _canvas: OffscreenCanvas;

	private readonly _glyphMap: TwoKeyMap<string, number, ITextureAtlasGlyph> = new TwoKeyMap();
	// HACK: This is an ordered set of glyphs to be passed to the GPU since currently the shader
	//       uses the index of the glyph. This should be improved to derive from _glyphMap
	private readonly _glyphInOrderSet: Set<ITextureAtlasGlyph> = new Set();
	get glyphs(): IterableIterator<ITextureAtlasGlyph> {
		return this._glyphInOrderSet.values();
	}

	private readonly _allocator: ITextureAtlasAllocator;

	private _colorMap!: string[];

	get source(): OffscreenCanvas {
		return this._canvas;
	}

	// TODO: Should pull in the font size from config instead of random dom node
	constructor(
		textureIndex: number,
		pageSize: number,
		allocatorType: 'shelf' | 'slab',
		@ILogService private readonly _logService: ILogService,
		@IThemeService private readonly _themeService: IThemeService,
	) {
		super();

		this._canvas = new OffscreenCanvas(pageSize, pageSize);

		switch (allocatorType) {
			case 'shelf': this._allocator = new TextureAtlasShelfAllocator(this._canvas, textureIndex); break;
			case 'slab': this._allocator = new TextureAtlasSlabAllocator(this._canvas, textureIndex); break;
		}

		this._register(Event.runAndSubscribe(this._themeService.onDidColorThemeChange, () => {
			// TODO: Clear entire atlas on theme change
			this._colorMap = this._themeService.getColorTheme().tokenColorMap;
		}));

		// Reduce impact of a memory leak if this object is not released
		this._register(toDisposable(() => {
			this._canvas.width = 1;
			this._canvas.height = 1;
		}));
	}

	// TODO: Color, style etc.
	public getGlyph(rasterizer: GlyphRasterizer, chars: string, metadata: number): Readonly<ITextureAtlasGlyph> {
		return this._glyphMap.get(chars, metadata) ?? this._createGlyph(rasterizer, chars, metadata);
	}

	private _createGlyph(rasterizer: GlyphRasterizer, chars: string, metadata: number): Readonly<ITextureAtlasGlyph> {
		const rasterizedGlyph = rasterizer.rasterizeGlyph(chars, metadata, this._colorMap);
		// TODO: Handle undefined allocate result
		const glyph = this._allocator.allocate(chars, metadata, rasterizedGlyph)!;
		this._glyphMap.set(chars, metadata, glyph);
		this._glyphInOrderSet.add(glyph);

		this._version++;
		this._usedArea.right = Math.max(this._usedArea.right, glyph.x + glyph.w);
		this._usedArea.bottom = Math.max(this._usedArea.bottom, glyph.y + glyph.h);

		if (this._logService.getLevel() === LogLevel.Trace) {
			this._logService.trace('New glyph', {
				chars,
				fg: this._colorMap[metadata],
				rasterizedGlyph,
				glyph
			});
		}

		return glyph;
	}

	getUsagePreview(): Promise<Blob> {
		// TODO: Standardize usage stats and make them loggable
		return this._allocator.getUsagePreview();
	}

	getStats(): string {
		return this._allocator.getStats();
	}
}