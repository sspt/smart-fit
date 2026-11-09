// Minimal ambient types for the Web Bluetooth API (not part of TS's DOM lib).
// Covers GATT connect + notified/indicated characteristics (read+write) —
// the read+write surface is needed for the FTMS Control Point (writeValue to
// send commands, characteristicvaluechanged to receive indicated responses)
// and the Fitness Machine Feature characteristic (a plain one-shot readValue).
// Android/Chrome only; every call site feature-detects `navigator.bluetooth`
// before touching any of this.

interface BluetoothCharacteristicProperties {
  readonly read: boolean;
  readonly write: boolean;
  readonly writeWithoutResponse: boolean;
  readonly notify: boolean;
  readonly indicate: boolean;
  // Also in the spec, and worth recording in a device report even though
  // nothing in this app acts on them — a characteristic that is broadcast- or
  // signed-write-only explains a device that otherwise looks inert.
  readonly broadcast: boolean;
  readonly authenticatedSignedWrites: boolean;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly uuid: string;
  readonly properties: BluetoothCharacteristicProperties;
  readonly value: DataView | undefined;
  readValue(): Promise<DataView>;
  // Unqualified writeValue() has always performed a write-WITH-response in the
  // Web Bluetooth API — exactly what the FTMS Control Point's GATT "Write"
  // property requires. No need for the separate WithResponse/WithoutResponse
  // variants added later, this app only ever needs the one.
  writeValue(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  addEventListener(
    type: "characteristicvaluechanged",
    listener: (this: BluetoothRemoteGATTCharacteristic, ev: Event) => void,
  ): void;
  removeEventListener(
    type: "characteristicvaluechanged",
    listener: (this: BluetoothRemoteGATTCharacteristic, ev: Event) => void,
  ): void;
}

interface BluetoothRemoteGATTService {
  readonly uuid: string;
  getCharacteristic(
    characteristic: number | string,
  ): Promise<BluetoothRemoteGATTCharacteristic>;
  getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(
    service: number | string,
  ): Promise<BluetoothRemoteGATTService>;
  // No-arg form used only by the device diagnostic (ble.ts's runBleDiagnostic) —
  // returns every primary service the origin was granted access to (i.e. every
  // UUID that was in requestDevice's filters/optionalServices AND is actually
  // present on the device), which is how it enumerates "what does this device
  // expose" without needing to already know its exact GATT layout up front.
  getPrimaryServices(): Promise<BluetoothRemoteGATTService[]>;
}

interface BluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
  addEventListener(
    type: "gattserverdisconnected",
    listener: (this: BluetoothDevice, ev: Event) => void,
  ): void;
  removeEventListener(
    type: "gattserverdisconnected",
    listener: (this: BluetoothDevice, ev: Event) => void,
  ): void;
}

interface RequestDeviceOptions {
  filters?: Array<{
    services?: Array<number | string>;
    name?: string;
    namePrefix?: string;
  }>;
  optionalServices?: Array<number | string>;
  acceptAllDevices?: boolean;
}

interface Bluetooth {
  getDevices?(): Promise<BluetoothDevice[]>;
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface Navigator {
  readonly bluetooth?: Bluetooth;
}
