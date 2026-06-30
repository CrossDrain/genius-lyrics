import { ReactiveStore } from "@luna/core";
import { LunaNumberSetting, LunaSettings, LunaSwitchSetting } from "@luna/ui";
import React from "react";

declare global {
	interface Window {
		updateGeniusLyricsFontSize?: () => void;
	}
}

export const settings = await ReactiveStore.getPluginStorage("GeniusLyrics", {
	hideSectionHeaders: false,
	autoRefetchOnTrackChange: true,
	lyricsFontSize: 100,
	hideAnnotationHighlighting: false,
});

export const Settings = () => {
	const [hideSectionHeaders, setHideSectionHeaders] = React.useState(
		settings.hideSectionHeaders,
	);
	const [autoRefetchOnTrackChange, setAutoRefetchOnTrackChange] = React.useState(
		settings.autoRefetchOnTrackChange,
	);
	const [lyricsFontSize, setLyricsFontSize] = React.useState(settings.lyricsFontSize);
	const [hideAnnotationHighlighting, setHideAnnotationHighlighting] = React.useState(
		settings.hideAnnotationHighlighting,
	);

	return (
		<LunaSettings>
			<LunaNumberSetting
				title="Lyrics font size"
				desc="Scale the Genius lyrics font size (50-200%, default: 100)"
				min={50}
				max={200}
				step={5}
				value={lyricsFontSize}
				onNumber={(value: number) => {
					settings.lyricsFontSize = value;
					setLyricsFontSize(value);
					window.updateGeniusLyricsFontSize?.();
				}}
			/>
			<LunaSwitchSetting
				title="Hide section headers"
				desc="Remove [Verse], [Chorus] style markers from the fetched lyrics"
				checked={hideSectionHeaders}
				onChange={(_: React.ChangeEvent<HTMLInputElement>, checked?: boolean) => {
					const value = checked ?? false;
					settings.hideSectionHeaders = value;
					setHideSectionHeaders(value);
				}}
			/>
			<LunaSwitchSetting
				title="Auto-refetch on track change"
				desc="When the Genius panel is open, automatically load lyrics for the next track"
				checked={autoRefetchOnTrackChange}
				onChange={(_: React.ChangeEvent<HTMLInputElement>, checked?: boolean) => {
					const value = checked ?? false;
					settings.autoRefetchOnTrackChange = value;
					setAutoRefetchOnTrackChange(value);
				}}
			/>
			<LunaSwitchSetting
				title="Disable annotation highlighting"
				desc="Don't highlight or make clickable the lyric fragments that have a Genius annotation"
				checked={hideAnnotationHighlighting}
				onChange={(_: React.ChangeEvent<HTMLInputElement>, checked?: boolean) => {
					const value = checked ?? false;
					settings.hideAnnotationHighlighting = value;
					setHideAnnotationHighlighting(value);
				}}
			/>
		</LunaSettings>
	);
};
