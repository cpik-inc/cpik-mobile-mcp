import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import * as xml from "fast-xml-parser";

import { ActionableError, Button, InstalledApp, Orientation, Robot, ScreenElement, ScreenElementRect, ScreenSize, SwipeDirection } from "./robot";

export interface AndroidDevice {
	deviceId: string;
	deviceType: "tv" | "mobile";
}

interface UiAutomatorXmlNode {
	node: UiAutomatorXmlNode[];
	class?: string;
	text?: string;
	bounds?: string;
	hint?: string;
	focused?: string;
	"content-desc"?: string;
	"resource-id"?: string;
}

interface UiAutomatorXml {
	hierarchy: {
		node: UiAutomatorXmlNode;
	};
}

const getAdbPath = (): string => {
	const exeName = process.env.platform === "win32" ? "adb.exe" : "adb";
	if (process.env.ANDROID_HOME) {
		return path.join(process.env.ANDROID_HOME, "platform-tools", exeName);
	}

	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const windowsAdbPath = path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe");
		if (existsSync(windowsAdbPath)) {
			return windowsAdbPath;
		}
	}

	if (process.platform === "darwin" && process.env.HOME) {
		const defaultAndroidSdk = path.join(process.env.HOME, "Library", "Android", "sdk", "platform-tools", "adb");
		if (existsSync(defaultAndroidSdk)) {
			return defaultAndroidSdk;
		}
	}

	// fallthrough, hope for the best
	return exeName;
};

const BUTTON_MAP: Record<Button, string> = {
	BACK: "KEYCODE_BACK",
	HOME: "KEYCODE_HOME",
	VOLUME_UP: "KEYCODE_VOLUME_UP",
	VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
	ENTER: "KEYCODE_ENTER",
	DPAD_CENTER: "KEYCODE_DPAD_CENTER",
	DPAD_UP: "KEYCODE_DPAD_UP",
	DPAD_DOWN: "KEYCODE_DPAD_DOWN",
	DPAD_LEFT: "KEYCODE_DPAD_LEFT",
	DPAD_RIGHT: "KEYCODE_DPAD_RIGHT",
};

const TIMEOUT = 30000;
const MAX_BUFFER_SIZE = 1024 * 1024 * 4;

type AndroidDeviceType = "tv" | "mobile";

export class AndroidRobot implements Robot {
	public constructor(private deviceId: string) {}

	public adb(...args: string[]): Buffer {
		return execFileSync(getAdbPath(), ["-s", this.deviceId, ...args], {
			maxBuffer: MAX_BUFFER_SIZE,
			timeout: TIMEOUT,
		});
	}

	public silentAdb(...args: string[]): Buffer {
		return execFileSync(getAdbPath(), ["-s", this.deviceId, ...args], {
			maxBuffer: MAX_BUFFER_SIZE,
			timeout: TIMEOUT,
			stdio: ["pipe", "pipe", "pipe"],
		});
	}

	public getSystemFeatures(): string[] {
		return this.adb("shell", "pm", "list", "features")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("feature:"))
			.map(line => line.substring("feature:".length));
	}

	public async getScreenSize(): Promise<ScreenSize> {
		const screenSize = this.adb("shell", "wm", "size").toString().split(" ").pop();

		if (!screenSize) {
			throw new Error("Failed to get screen size");
		}

		const scale = 1;
		const [width, height] = screenSize.split("x").map(Number);
		return { width, height, scale };
	}

	public async listApps(): Promise<InstalledApp[]> {
		// only apps that have a launcher activity are returned
		return this.adb(
			"shell",
			"cmd",
			"package",
			"query-activities",
			"-a",
			"android.intent.action.MAIN",
			"-c",
			"android.intent.category.LAUNCHER"
		)
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("packageName="))
			.map(line => line.substring("packageName=".length))
			.filter((value, index, self) => self.indexOf(value) === index)
			.map(packageName => ({
				packageName,
				appName: packageName,
			}));
	}

	private async listPackages(): Promise<string[]> {
		return this.adb("shell", "pm", "list", "packages")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("package:"))
			.map(line => line.substring("package:".length));
	}

	public async launchApp(packageName: string): Promise<void> {
		try {
			this.silentAdb("shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1");
		} catch (error) {
			throw new ActionableError(`Failed launching app with package name "${packageName}", please make sure it exists`);
		}
	}

	public async listRunningProcesses(): Promise<string[]> {
		return this.adb("shell", "ps", "-e")
			.toString()
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.startsWith("u")) // non-system processes
			.map(line => line.split(/\s+/)[8]); // get process name
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const screenSize = await this.getScreenSize();
		const centerX = screenSize.width >> 1;

		let x0: number, y0: number, x1: number, y1: number;

		switch (direction) {
			case "up":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.8);
				y1 = Math.floor(screenSize.height * 0.2);
				break;
			case "down":
				x0 = x1 = centerX;
				y0 = Math.floor(screenSize.height * 0.2);
				y1 = Math.floor(screenSize.height * 0.8);
				break;
			case "left":
				x0 = Math.floor(screenSize.width * 0.8);
				x1 = Math.floor(screenSize.width * 0.2);
				y0 = y1 = Math.floor(screenSize.height * 0.5);
				break;
			case "right":
				x0 = Math.floor(screenSize.width * 0.2);
				x1 = Math.floor(screenSize.width * 0.8);
				y0 = y1 = Math.floor(screenSize.height * 0.5);
				break;
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}

		this.adb("shell", "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, "1000");
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const screenSize = await this.getScreenSize();

		let x0: number, y0: number, x1: number, y1: number;

		// Use provided distance or default to 30% of screen dimension
		const defaultDistanceY = Math.floor(screenSize.height * 0.3);
		const defaultDistanceX = Math.floor(screenSize.width * 0.3);
		const swipeDistanceY = distance || defaultDistanceY;
		const swipeDistanceX = distance || defaultDistanceX;

		switch (direction) {
			case "up":
				x0 = x1 = x;
				y0 = y;
				y1 = Math.max(0, y - swipeDistanceY);
				break;
			case "down":
				x0 = x1 = x;
				y0 = y;
				y1 = Math.min(screenSize.height, y + swipeDistanceY);
				break;
			case "left":
				x0 = x;
				x1 = Math.max(0, x - swipeDistanceX);
				y0 = y1 = y;
				break;
			case "right":
				x0 = x;
				x1 = Math.min(screenSize.width, x + swipeDistanceX);
				y0 = y1 = y;
				break;
			default:
				throw new ActionableError(`Swipe direction "${direction}" is not supported`);
		}

		this.adb("shell", "input", "swipe", `${x0}`, `${y0}`, `${x1}`, `${y1}`, "1000");
	}

	private getDisplayCount(): number {
		return this.adb("shell", "dumpsys", "SurfaceFlinger", "--display-id")
			.toString()
			.split("\n")
			.filter(s => s.startsWith("Display ")).length;
	}

	private getFirstDisplayId(): string | null {
		try {
			// Try using cmd display get-displays (Android 11+)
			const displays = this.adb("shell", "cmd", "display", "get-displays")
				.toString()
				.split("\n")
				.filter(s => s.startsWith("Display id "))
				// filter for state ON even though get-displays only returns turned on displays
				.filter(s => s.indexOf(", state ON,") >= 0)
				// another paranoia check
				.filter(s => s.indexOf(", uniqueId ") >= 0);

			if (displays.length > 0) {
				const m = displays[0].match(/uniqueId \"([^\"]+)\"/);
				if (m !== null) {
					let displayId = m[1];
					if (displayId.startsWith("local:")) {
						displayId = displayId.substring("local:".length);
					}

					return displayId;
				}
			}
		} catch (error) {
			// cmd display get-displays not available on this device
		}

		// fallback: parse dumpsys display for display info (compatible with older Android versions)
		try {
			const dumpsys = this.adb("shell", "dumpsys", "display").toString();

			// look for DisplayViewport entries with isActive=true and type=INTERNAL
			const viewportMatch = dumpsys.match(/DisplayViewport\{type=INTERNAL[^}]*isActive=true[^}]*uniqueId='([^']+)'/);
			if (viewportMatch) {
				let uniqueId = viewportMatch[1];
				if (uniqueId.startsWith("local:")) {
					uniqueId = uniqueId.substring("local:".length);
				}

				return uniqueId;
			}

			// fallback: look for active display with state ON
			const displayStateMatch = dumpsys.match(/Display Id=(\d+)[\s\S]*?Display State=ON/);
			if (displayStateMatch) {
				return displayStateMatch[1];
			}
		} catch (error) {
			// dumpsys display also failed
		}

		return null;
	}

	public async getScreenshot(): Promise<Buffer> {
		if (this.getDisplayCount() <= 1) {
			// backward compatibility for android 10 and below, and for single display devices
			return this.adb("exec-out", "screencap", "-p");
		}

		// find the first display that is turned on, and capture that one
		const displayId = this.getFirstDisplayId();
		if (displayId === null) {
			// no idea why, but we have displayCount >= 2, yet we failed to parse
			// let's go with screencap's defaults and hope for the best
			return this.adb("exec-out", "screencap", "-p");
		}

		return this.adb("exec-out", "screencap", "-p", "-d", `${displayId}`);
	}

	private collectElements(node: UiAutomatorXmlNode): ScreenElement[] {
		const elements: Array<ScreenElement> = [];

		if (node.node) {
			if (Array.isArray(node.node)) {
				for (const childNode of node.node) {
					elements.push(...this.collectElements(childNode));
				}
			} else {
				elements.push(...this.collectElements(node.node));
			}
		}

		if (node.text || node["content-desc"] || node.hint) {
			const element: ScreenElement = {
				type: node.class || "text",
				text: node.text,
				label: node["content-desc"] || node.hint || "",
				rect: this.getScreenElementRect(node),
			};

			if (node.focused === "true") {
				// only provide it if it's true, otherwise don't confuse llm
				element.focused = true;
			}

			const resourceId = node["resource-id"];
			if (resourceId !== null && resourceId !== "") {
				element.identifier = resourceId;
			}

			if (element.rect.width > 0 && element.rect.height > 0) {
				elements.push(element);
			}
		}

		return elements;
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		// Retry up to 3 times if we get empty elements (might be during screen transition)
		for (let retry = 0; retry < 3; retry++) {
			const parsedXml = await this.getUiAutomatorXml();
			const hierarchy = parsedXml.hierarchy;
			const elements = this.collectElements(hierarchy.node);

			// If we got elements, return them
			if (elements.length > 0) {
				return elements;
			}

			// If empty and not last retry, wait a bit before retrying
			if (retry < 2) {
				await new Promise(resolve => setTimeout(resolve, 500));
			}
		}

		// After all retries, return empty array (might be legitimately empty screen)
		return [];
	}

	public async terminateApp(packageName: string): Promise<void> {
		this.adb("shell", "am", "force-stop", packageName);
	}

	public async installApp(path: string): Promise<void> {
		try {
			this.adb("install", "-r", path);
		} catch (error: any) {
			const stdout = error.stdout ? error.stdout.toString() : "";
			const stderr = error.stderr ? error.stderr.toString() : "";
			const output = (stdout + stderr).trim();
			throw new ActionableError(output || error.message);
		}
	}

	public async uninstallApp(bundleId: string): Promise<void> {
		try {
			this.adb("uninstall", bundleId);
		} catch (error: any) {
			const stdout = error.stdout ? error.stdout.toString() : "";
			const stderr = error.stderr ? error.stderr.toString() : "";
			const output = (stdout + stderr).trim();
			throw new ActionableError(output || error.message);
		}
	}

	public async openUrl(url: string): Promise<void> {
		this.adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url);
	}

	private isAscii(text: string): boolean {
		return /^[\x00-\x7F]*$/.test(text);
	}

	private escapeShellText(text: string): string {
		// escape all shell special characters that could be used for injection
		return text.replace(/[\\'"` \t\n\r|&;()<>{}[\]$*?]/g, "\\$&");
	}

	private async isDeviceKitInstalled(): Promise<boolean> {
		const packages = await this.listPackages();
		return packages.includes("com.mobilenext.devicekit");
	}

	public async sendKeys(text: string): Promise<void> {
		if (text === "") {
			// bailing early, so we don't run adb shell with empty string.
			// this happens when you prompt with a simple "submit".
			return;
		}

		if (await this.isDeviceKitInstalled()) {
			// Use DeviceKit's clipboard method (preferred for all text)
			console.log("Sending text to clipboard:", text);
			const base64 = Buffer.from(text).toString("base64");
			console.log("Base64 encoded text:", base64);

			// send clipboard over and immediately paste it
			this.adb(
				"shell",
				"am",
				"broadcast",
				"-a",
				"devicekit.clipboard.set",
				"-e",
				"encoding",
				"base64",
				"-e",
				"text",
				base64,
				"-n",
				"com.mobilenext.devicekit/.ClipboardBroadcastReceiver"
			);
			console.log("Sent clipboard over");
			this.adb("shell", "input", "keyevent", "KEYCODE_PASTE");
			console.log("Pressed paste key event");

			// clear clipboard when we're done
			this.adb(
				"shell",
				"am",
				"broadcast",
				"-a",
				"devicekit.clipboard.clear",
				"-n",
				"com.mobilenext.devicekit/.ClipboardBroadcastReceiver"
			);
		} else if (this.isAscii(text)) {
			// Fallback to adb shell input for ASCII text only
			const _text = this.escapeShellText(text);
			this.adb("shell", "input", "text", _text);
		} else {
			throw new ActionableError(
				"Non-ASCII text is not supported on Android, please install mobilenext devicekit, see https://github.com/mobile-next/devicekit-android"
			);
		}
	}

	public async pressButton(button: Button) {
		if (!BUTTON_MAP[button]) {
			throw new ActionableError(`Button "${button}" is not supported`);
		}

		const mapped = BUTTON_MAP[button];
		this.adb("shell", "input", "keyevent", mapped);
	}

	public async tap(x: number, y: number): Promise<void> {
		this.adb("shell", "input", "tap", `${x}`, `${y}`);
	}

	public async longPress(x: number, y: number): Promise<void> {
		// a long press is a swipe with no movement and a long duration
		this.adb("shell", "input", "swipe", `${x}`, `${y}`, `${x}`, `${y}`, "500");
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		await this.tap(x, y);
		await new Promise(r => setTimeout(r, 100)); // short delay
		await this.tap(x, y);
	}

	public async setClipboard(text: string): Promise<void> {
		if (await this.isDeviceKitInstalled()) {
			console.log("Setting clipboard to:", text);
			// Use DeviceKit's broadcast method with Base64 encoding (preferred)
			const base64 = Buffer.from(text).toString("base64");
			this.adb(
				"shell",
				"am",
				"broadcast",
				"-a",
				"devicekit.clipboard.set",
				"-e",
				"encoding",
				"base64",
				"-e",
				"text",
				base64,
				"-n",
				"com.mobilenext.devicekit/.ClipboardBroadcastReceiver"
			);
		} else {
			console.log("DeviceKit not installed, falling back to cmd clipboard");
			// Fallback to cmd clipboard (only supports ASCII)
			const isAscii = this.isAscii(text);
			if (!isAscii) {
				console.log("Non-ASCII text not supported, falling back to cmd clipboard");
				throw new ActionableError(
					"Non-ASCII text is not supported on Android, please install mobilenext devicekit, see https://github.com/mobile-next/devicekit-android"
				);
			}
			this.adb("shell", "cmd", "clipboard", "set-text", text);
		}
	}

	public getClipboard(): string {
		// Use cmd clipboard to get text (Android 10+)
		return this.adb("shell", "cmd", "clipboard", "get-text").toString().trim();
	}

	public async pasteFromClipboard(): Promise<void> {
		// const clipboardContent = this.getClipboard();

		// if (!clipboardContent) {
		// 	throw new ActionableError("Clipboard is empty, nothing to paste");
		// }

		// Send the paste key event (KEYCODE_PASTE is 279)
		this.adb("shell", "input", "keyevent", "279");
	}

	public clearTextField(): void {
		// Clear text in focused field by selecting all (Ctrl+A) and deleting
		// input keycombination 113 29 && input keyevent 67

		this.adb("shell", "input", "keycombination", "113", "29"); // KEYCODE_CTRL_LEFT down
		this.adb("shell", "input", "keyevent", "67"); // KEYCODE_DEL (delete)
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		const value = orientation === "portrait" ? 0 : 1;

		// disable auto-rotation prior to setting the orientation
		this.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
		this.adb(
			"shell",
			"content",
			"insert",
			"--uri",
			"content://settings/system",
			"--bind",
			"name:s:user_rotation",
			"--bind",
			`value:i:${value}`
		);
	}

	public async getOrientation(): Promise<Orientation> {
		const rotation = this.adb("shell", "settings", "get", "system", "user_rotation").toString().trim();
		return rotation === "0" ? "portrait" : "landscape";
	}

	public getDeviceHardwareInfo(): {
		manufacturer: string;
		model: string;
		brand: string;
		device: string;
		androidVersion: string;
		sdkVersion: string;
		cpuAbi: string;
		buildId: string;
		} {
		// Get various device hardware properties using getprop
		const manufacturer = this.adb("shell", "getprop", "ro.product.manufacturer").toString().trim();
		const model = this.adb("shell", "getprop", "ro.product.model").toString().trim();
		const brand = this.adb("shell", "getprop", "ro.product.brand").toString().trim();
		const device = this.adb("shell", "getprop", "ro.product.device").toString().trim();
		const androidVersion = this.adb("shell", "getprop", "ro.build.version.release").toString().trim();
		const sdkVersion = this.adb("shell", "getprop", "ro.build.version.sdk").toString().trim();
		const cpuAbi = this.adb("shell", "getprop", "ro.product.cpu.abi").toString().trim();
		const buildId = this.adb("shell", "getprop", "ro.build.id").toString().trim();

		return {
			manufacturer,
			model,
			brand,
			device,
			androidVersion,
			sdkVersion,
			cpuAbi,
			buildId,
		};
	}

	private async getUiAutomatorDump(): Promise<string> {
		for (let tries = 0; tries < 10; tries++) {
			const dump = this.adb("exec-out", "uiautomator", "dump", "/dev/tty").toString();
			// note: we're not catching other errors here. maybe we should check for <?xml
			if (dump.includes("null root node returned by UiTestAutomationBridge")) {
				// uncomment for debugging
				// const screenshot = await this.getScreenshot();
				// console.error("Failed to get UIAutomator XML. Here's a screenshot: " + screenshot.toString("base64"));
				continue;
			}

			return dump.substring(dump.indexOf("<?xml"));
		}

		throw new ActionableError("Failed to get UIAutomator XML");
	}

	private async getUiAutomatorXml(): Promise<UiAutomatorXml> {
		const dump = await this.getUiAutomatorDump();
		const parser = new xml.XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "",
		});

		return parser.parse(dump) as UiAutomatorXml;
	}

	private getScreenElementRect(node: UiAutomatorXmlNode): ScreenElementRect {
		const bounds = String(node.bounds);

		const [, left, top, right, bottom] = bounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.map(Number) || [];
		return {
			x: left,
			y: top,
			width: right - left,
			height: bottom - top,
		};
	}
}

export class AndroidDeviceManager {
	private getDeviceType(name: string): AndroidDeviceType {
		const device = new AndroidRobot(name);
		const features = device.getSystemFeatures();
		if (features.includes("android.software.leanback") || features.includes("android.hardware.type.television")) {
			return "tv";
		}

		return "mobile";
	}

	public getConnectedDevices(): AndroidDevice[] {
		try {
			const names = execFileSync(getAdbPath(), ["devices"])
				.toString()
				.split("\n")
				.map(line => line.trim())
				.filter(line => line !== "")
				.filter(line => !line.startsWith("List of devices attached"))
				.map(line => line.split("\t")[0]);

			return names.map(name => ({
				deviceId: name,
				deviceType: this.getDeviceType(name),
			}));
		} catch (error) {
			console.error("Could not execute adb command, maybe ANDROID_HOME is not set?");
			return [];
		}
	}
}
