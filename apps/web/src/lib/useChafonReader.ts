import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CHAFON_NOTIFY,
  CHAFON_SERVICE,
  CHAFON_WRITE,
  CMD_DEVICE_INFO,
  CMD_GET_ALL_PARAMS,
  CMD_INVENTORY,
  CMD_SET_ALL_PARAMS,
  ChafonFrameParser,
  STATUS_INVENTORY_DONE,
  STATUS_OK,
  deviceInfoCommand,
  getParamsCommand,
  parseKey,
  parseModel,
  parseParams,
  parseTag,
  powerRange,
  setPowerCommand,
  startInventoryCommand,
  stopInventoryCommand,
  type ChafonFrame,
  type ReaderParams,
  type TagRead,
} from './chafon'

export type ReaderStatus = 'unsupported' | 'idle' | 'connecting' | 'connected'

// Read range = RF output power (dBm). `value` is null until read from the reader.
export interface ReaderPower {
  value: number | null
  min: number
  max: number
  model: string | null
  busy: boolean
  error: string | null
  saved: boolean
}

const RESPONSE_MS = 2000
const initialPower: ReaderPower = { ...powerRange(null), value: null, model: null, busy: false, error: null, saved: false }

interface Connection {
  device: BluetoothDevice
  write: BluetoothRemoteGATTCharacteristic
  notify: BluetoothRemoteGATTCharacteristic
  onValue: (event: Event) => void
  onDisconnect: () => void
}

// Last reader chosen in this page (memory only, never stored): «Reconectar»
// uses it without opening the device chooser again, also after leaving the
// bulk reading screen and coming back. A reload forgets it.
let rememberedDevice: BluetoothDevice | null = null

// Web Bluetooth needs Chrome (Android or desktop) and HTTPS (or localhost).
export const bluetoothSupported = () =>
  typeof navigator !== 'undefined' && !!navigator.bluetooth && window.isSecureContext

// Direct connection to a Chafon handheld in "transparent" Bluetooth mode.
// Tags arrive while the trigger is held or after `start()`; read-only: the
// app never writes, locks or kills tags.
export function useChafonReader(onTag: (tag: TagRead) => void) {
  const [status, setStatus] = useState<ReaderStatus>(() => (bluetoothSupported() ? 'idle' : 'unsupported'))
  const [deviceName, setDeviceName] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [trigger, setTrigger] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [power, setPowerState] = useState<ReaderPower>(initialPower)
  const [canReconnect, setCanReconnect] = useState(() => rememberedDevice !== null)
  const connection = useRef<Connection | null>(null)
  const onTagRef = useRef(onTag)
  // Command responses awaited by `request`, by command code.
  const waiters = useRef(new Map<number, (frame: ChafonFrame) => void>())
  const params = useRef<ReaderParams | null>(null)

  useEffect(() => {
    onTagRef.current = onTag
  }, [onTag])

  const release = useCallback(() => {
    const current = connection.current
    connection.current = null
    waiters.current.clear()
    params.current = null
    if (!current) return
    current.notify.removeEventListener('characteristicvaluechanged', current.onValue)
    current.device.removeEventListener('gattserverdisconnected', current.onDisconnect)
    if (current.device.gatt?.connected) current.device.gatt.disconnect()
  }, [])

  const send = useCallback(async (bytes: Uint8Array<ArrayBuffer>) => {
    const write = connection.current?.write
    if (!write) throw new Error('Lector desconectado')
    if (write.properties.writeWithoutResponse && write.writeValueWithoutResponse) {
      await write.writeValueWithoutResponse(bytes)
    } else {
      await write.writeValue(bytes)
    }
  }, [])

  // Sends a command and waits for the reader's response to that command.
  const request = useCallback(
    (bytes: Uint8Array<ArrayBuffer>, cmd: number) =>
      new Promise<ChafonFrame>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          waiters.current.delete(cmd)
          reject(new Error('Sin respuesta del lector'))
        }, RESPONSE_MS)
        waiters.current.set(cmd, (frame) => {
          window.clearTimeout(timer)
          waiters.current.delete(cmd)
          resolve(frame)
        })
        send(bytes).catch((err: unknown) => {
          window.clearTimeout(timer)
          waiters.current.delete(cmd)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      }),
    [send],
  )

  const readParams = useCallback(async () => {
    // A sleeping reader may ignore the first command (the vendor app retries).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const found = parseParams(await request(getParamsCommand(), CMD_GET_ALL_PARAMS))
        if (found) return found
      } catch {
        // Retry.
      }
    }
    return null
  }, [request])

  // Model (for the power range) and current power, right after connecting.
  const loadPower = useCallback(async () => {
    setPowerState((previous) => ({ ...previous, busy: true, error: null, saved: false }))
    let model: string | null = null
    try {
      model = parseModel(await request(deviceInfoCommand(), CMD_DEVICE_INFO))
    } catch {
      // Unknown model: general range.
    }
    const found = await readParams()
    params.current = found
    setPowerState({
      ...powerRange(model),
      model,
      value: found?.power ?? null,
      busy: false,
      saved: false,
      error: found ? null : 'No se pudo leer la distancia configurada en la pistola.',
    })
  }, [readParams, request])

  // Writes the new power keeping every other reader parameter as it was.
  const setPower = useCallback(
    async (value: number) => {
      const current = params.current
      if (!current) return
      setPowerState((previous) => ({ ...previous, busy: true, error: null, saved: false }))
      try {
        const ack = await request(setPowerCommand(current, value), CMD_SET_ALL_PARAMS)
        if (ack.status !== STATUS_OK) throw new Error('rejected')
        // Read back what the reader stored.
        const stored = await readParams()
        params.current = stored ?? { raw: current.raw, power: value }
        setPowerState((previous) => ({ ...previous, value: params.current!.power, busy: false, saved: true }))
      } catch (err) {
        setPowerState((previous) => ({
          ...previous,
          busy: false,
          error:
            err instanceof Error && err.message === 'rejected'
              ? 'La pistola no aceptó esa distancia. Prueba con un valor menor.'
              : 'No se pudo cambiar la distancia. Revisa la conexión con el lector.',
        }))
      }
    },
    [readParams, request],
  )

  // Opens the GATT link to `device` and subscribes to its notifications.
  // Exactly one set of listeners per connection: they are removed on any
  // disconnection (expected or not), so reconnecting never duplicates them.
  const attach = useCallback(async (device: BluetoothDevice) => {
    try {
      const server = await device.gatt!.connect()
      let service: BluetoothRemoteGATTService
      try {
        service = await server.getPrimaryService(CHAFON_SERVICE)
      } catch {
        throw new Error(
          'Ese dispositivo no es un lector Chafon o está en modo HID (teclado). En la app «UHF Reader» del fabricante cambia la salida a «transparente» o usa el modo teclado de esta pantalla.',
        )
      }
      const write = await service.getCharacteristic(CHAFON_WRITE)
      const notify = await service.getCharacteristic(CHAFON_NOTIFY)
      const parser = new ChafonFrameParser()

      const onValue = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value
        if (!value) return
        for (const frame of parser.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))) {
          const waiter = waiters.current.get(frame.cmd)
          if (waiter) {
            waiter(frame)
            continue
          }
          const tag = parseTag(frame)
          if (tag) {
            onTagRef.current(tag)
            continue
          }
          if (frame.cmd === CMD_INVENTORY && frame.status === STATUS_INVENTORY_DONE) setReading(false)
          const key = parseKey(frame)
          if (key !== null) setTrigger(key)
        }
      }
      const onDisconnect = () => {
        // Only unexpected disconnections land here (release() unsubscribes):
        // reader turned off or out of range, screen locked, app in the
        // background… Nothing is read meanwhile; the list is kept.
        notify.removeEventListener('characteristicvaluechanged', onValue)
        device.removeEventListener('gattserverdisconnected', onDisconnect)
        connection.current = null
        waiters.current.clear()
        params.current = null
        setPowerState(initialPower)
        setStatus('idle')
        setReading(false)
        setTrigger(false)
        setError('Se perdió la conexión con el lector (por ejemplo al bloquear la pantalla, salir de la app o alejarse). Pulsa «Reconectar»; las lecturas de la lista se conservan.')
      }

      notify.addEventListener('characteristicvaluechanged', onValue)
      device.addEventListener('gattserverdisconnected', onDisconnect)
      connection.current = { device, write, notify, onValue, onDisconnect }
      await notify.startNotifications()
      setDeviceName(device.name || 'Lector Chafon')
      rememberedDevice = device
      setCanReconnect(true)
      setStatus('connected')
      void loadPower()
    } catch (err) {
      release()
      if (device.gatt?.connected) device.gatt.disconnect()
      setStatus('idle')
      setError(
        err instanceof Error && !(err instanceof DOMException)
          ? err.message
          : 'No se pudo conectar con el lector. Verifica que esté encendido, cerca y sin otra app conectada.',
      )
    }
  }, [loadPower, release])

  const connect = useCallback(async () => {
    if (!navigator.bluetooth || connection.current) return
    setError(null)
    setStatus('connecting')
    let device: BluetoothDevice
    try {
      // The reader does not always advertise its service: let the user pick
      // it from the list and request access to the Chafon service.
      device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [CHAFON_SERVICE] })
    } catch (err) {
      setStatus('idle')
      // Closing the device chooser is not an error.
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) {
        setError('No se pudo abrir la lista de dispositivos Bluetooth.')
      }
      return
    }
    await attach(device)
  }, [attach])

  // Same reader as before, without the chooser (after a lost connection).
  const reconnect = useCallback(async () => {
    const device = rememberedDevice
    if (!device || connection.current) return
    setError(null)
    setStatus('connecting')
    await attach(device)
  }, [attach])

  const start = useCallback(async () => {
    setError(null)
    try {
      await send(startInventoryCommand())
      setReading(true)
    } catch {
      setError('No se pudo iniciar la lectura. Revisa la conexión con el lector.')
    }
  }, [send])

  const stop = useCallback(async () => {
    try {
      await send(stopInventoryCommand())
    } catch {
      // Disconnected: nothing is being read anyway.
    }
    setReading(false)
  }, [send])

  const disconnect = useCallback(async () => {
    if (reading) await stop()
    release()
    setStatus(bluetoothSupported() ? 'idle' : 'unsupported')
    setTrigger(false)
    setPowerState(initialPower)
  }, [reading, release, stop])

  // Leaving the screen stops the reader and frees the Bluetooth link.
  useEffect(
    () => () => {
      const current = connection.current
      if (current?.write) {
        void current.write.writeValue(stopInventoryCommand()).catch(() => undefined)
      }
      release()
    },
    [release],
  )

  return {
    status,
    deviceName,
    reading,
    trigger,
    error,
    connect,
    reconnect,
    canReconnect,
    disconnect,
    start,
    stop,
    power,
    setPower,
    reloadPower: loadPower,
  }
}
