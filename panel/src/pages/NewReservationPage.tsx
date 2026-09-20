import { useEffect, useState } from "react";
import { createManualReservation } from "../api/manualReservation";
import { getRoomRates, type RoomRatesGroup } from "../api/roomRates";
import type { ReservationDetail } from "../api/tapeChart";
import { ApiError } from "../api/client";
import { todayISO, addDaysUTC, formatDateUTC, parseDateUTC } from "../lib/dateUtils";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { TextField, SelectField } from "../components/ui/Field";
import DatePicker from "../components/ui/DatePicker";

// SDD "Nova reserva" panel change, PR 3a — form skeleton + any-unit
// submission. Unit selection (UnitPicker, PR 3b) is NOT part of this page
// yet: every submit sends `preferred_room_unit_id: undefined`, which is
// byte-identical to today's manual-reservation behavior (auto-assign
// `freeUnits[0]`). Field list frozen to exactly what
// `panelManualReservation.ts` accepts — see `api/manualReservation.ts`.
//
// Size reference: CashMovementFormPage.tsx (closest existing form of
// comparable shape/complexity in this codebase).

const MAX_CHILDREN = 8;
const MAX_BABIES = 4;

const PAYMENT_STATUS_OPTIONS: { value: "none" | "deposit_paid" | "paid_full"; label: string }[] = [
  { value: "none", label: "Sem pagamento" },
  { value: "deposit_paid", label: "Depósito pago" },
  { value: "paid_full", label: "Pago integralmente" },
];

const PAYMENT_METHOD_OPTIONS: { value: "cash" | "external" | "pix_manual"; label: string }[] = [
  { value: "cash", label: "Dinheiro" },
  { value: "pix_manual", label: "Pix" },
  { value: "external", label: "Outro" },
];

interface NewReservationPageProps {
  onSaved: (detail: ReservationDetail) => void;
  onCancel: () => void;
}

export default function NewReservationPage({ onSaved, onCancel }: NewReservationPageProps) {
  const [rooms, setRooms] = useState<RoomRatesGroup[] | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);

  const [roomId, setRoomId] = useState("");
  const [checkIn, setCheckIn] = useState(todayISO());
  const [checkOut, setCheckOut] = useState(formatDateUTC(addDaysUTC(parseDateUTC(todayISO()), 1)));

  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");

  const [adults, setAdults] = useState("2");
  const [children, setChildren] = useState("0");
  const [childrenAges, setChildrenAges] = useState<string[]>([]);
  const [babies, setBabies] = useState("0");
  const [pets, setPets] = useState(false);

  const [paymentStatus, setPaymentStatus] = useState<"none" | "deposit_paid" | "paid_full">("none");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "external" | "pix_manual" | "">("");
  const [overrideTotalReais, setOverrideTotalReais] = useState("");
  const [notes, setNotes] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRoomRates()
      .then((data) => {
        if (!cancelled) setRooms(data);
      })
      .catch(() => {
        if (!cancelled) setRoomsError("Não foi possível carregar os tipos de quarto.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keeps `children_ages` the exact length the backend requires
  // (`children_ages.length === children`, enforced by the same Zod refine
  // that guards `panelManualReservation.ts`) — grows/shrinks in place so
  // ages already typed for the first N children survive a count change.
  function handleChildrenChange(value: string) {
    setChildren(value);
    const count = Number(value);
    if (!Number.isInteger(count) || count < 0) return;
    setChildrenAges((prev) => {
      const next = prev.slice(0, count);
      while (next.length < count) next.push("");
      return next;
    });
  }

  function handleChildAgeChange(index: number, value: string) {
    setChildrenAges((prev) => prev.map((age, i) => (i === index ? value : age)));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!roomId) {
      setError("Selecione um tipo de quarto.");
      return;
    }
    if (checkOut <= checkIn) {
      // Client-side equivalent of the GET free-units endpoint's
      // INVALID_DATE_RANGE (that endpoint isn't wired into this page until
      // PR 3b) — the manual-reservation POST itself has no such error code,
      // so this never reaches the server.
      setError("A data de saída deve ser posterior à data de entrada.");
      return;
    }
    if (!guestName.trim()) {
      setError("Informe o nome do hóspede.");
      return;
    }
    const adultsValue = Number(adults);
    if (!Number.isInteger(adultsValue) || adultsValue < 1) {
      setError("Informe uma quantidade válida de adultos.");
      return;
    }
    const childrenValue = Number(children);
    if (!Number.isInteger(childrenValue) || childrenValue < 0 || childrenValue > MAX_CHILDREN) {
      setError("Informe uma quantidade válida de crianças.");
      return;
    }
    const parsedChildrenAges = childrenAges.map((age) => Number(age));
    if (childrenValue > 0 && parsedChildrenAges.some((age) => !Number.isInteger(age) || age < 3 || age > 17)) {
      setError("Informe a idade de cada criança (3 a 17 anos).");
      return;
    }
    const babiesValue = Number(babies);
    if (!Number.isInteger(babiesValue) || babiesValue < 0 || babiesValue > MAX_BABIES) {
      setError("Informe uma quantidade válida de bebês.");
      return;
    }
    if ((paymentStatus === "deposit_paid" || paymentStatus === "paid_full") && !paymentMethod) {
      setError("Selecione um método de pagamento.");
      return;
    }
    const overrideTotalCents =
      overrideTotalReais.trim() === "" ? undefined : Math.round(Number(overrideTotalReais) * 100);
    if (overrideTotalCents !== undefined && (!Number.isFinite(overrideTotalCents) || overrideTotalCents < 0)) {
      setError("Informe um valor de override válido.");
      return;
    }

    setSaving(true);
    try {
      const detail = await createManualReservation({
        room_id: Number(roomId),
        check_in: checkIn,
        check_out: checkOut,
        adults: adultsValue,
        children: childrenValue,
        children_ages: parsedChildrenAges,
        babies: babiesValue,
        pets,
        guest_name: guestName.trim(),
        guest_email: guestEmail.trim() || undefined,
        guest_phone: guestPhone.trim() || undefined,
        notes: notes.trim() || undefined,
        payment_status: paymentStatus,
        payment_method: paymentMethod || undefined,
        override_total_cents: overrideTotalCents,
        // No picker yet (PR 3b) — every submission from this page is "any
        // unit", matching today's freeUnits[0] auto-assignment.
        preferred_room_unit_id: undefined,
      });
      onSaved(detail);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.message === "NO_AVAILABILITY") {
        setError("Não há disponibilidade para este quarto nas datas selecionadas.");
      } else if (err instanceof ApiError && err.status === 404 && err.message === "ROOM_NOT_FOUND") {
        setError("Este tipo de quarto não está mais disponível.");
      } else {
        setError("Erro inesperado ao criar a reserva.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <Card as="form" onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {roomsError && <p className="text-sm text-danger-500 sm:col-span-2">{roomsError}</p>}
          <SelectField
            id="reservation-room"
            label="Tipo de quarto"
            required
            disabled={!rooms}
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          >
            <option value="">{rooms ? "Selecione..." : "Carregando..."}</option>
            {(rooms ?? []).map((room) => (
              <option key={room.room_id} value={room.room_id}>
                {room.room_name}
              </option>
            ))}
          </SelectField>

          <div className="flex gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[12.5px] font-medium text-panel-700">Entrada</span>
              <DatePicker value={checkIn} onChange={setCheckIn} label="Data de entrada" align="left" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12.5px] font-medium text-panel-700">Saída</span>
              <DatePicker value={checkOut} onChange={setCheckOut} label="Data de saída" align="left" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <TextField
            id="reservation-guest-name"
            label="Nome do hóspede"
            required
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
          />
          <TextField
            id="reservation-guest-email"
            label="E-mail (opcional)"
            type="email"
            value={guestEmail}
            onChange={(e) => setGuestEmail(e.target.value)}
          />
          <TextField
            id="reservation-guest-phone"
            label="Telefone (opcional)"
            value={guestPhone}
            onChange={(e) => setGuestPhone(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <TextField
            id="reservation-adults"
            label="Adultos"
            type="number"
            min={1}
            step="1"
            required
            value={adults}
            onChange={(e) => setAdults(e.target.value)}
          />
          <TextField
            id="reservation-children"
            label="Crianças"
            type="number"
            min={0}
            max={MAX_CHILDREN}
            step="1"
            value={children}
            onChange={(e) => handleChildrenChange(e.target.value)}
          />
          <TextField
            id="reservation-babies"
            label="Bebês"
            type="number"
            min={0}
            max={MAX_BABIES}
            step="1"
            value={babies}
            onChange={(e) => setBabies(e.target.value)}
          />
          <div className="flex flex-col gap-1 justify-end pb-1.5">
            <label className="flex items-center gap-2 text-[13px] text-panel-800">
              <input type="checkbox" checked={pets} onChange={(e) => setPets(e.target.checked)} />
              Animais de estimação
            </label>
          </div>
        </div>

        {childrenAges.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-medium text-panel-700">Idade das crianças</span>
            <div className="flex flex-wrap gap-3">
              {childrenAges.map((age, index) => (
                <TextField
                  key={index}
                  id={`reservation-child-age-${index}`}
                  label={`Criança ${index + 1}`}
                  type="number"
                  min={3}
                  max={17}
                  step="1"
                  required
                  className="w-24"
                  value={age}
                  onChange={(e) => handleChildAgeChange(index, e.target.value)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SelectField
            id="reservation-payment-status"
            label="Estado do pagamento"
            value={paymentStatus}
            onChange={(e) => setPaymentStatus(e.target.value as typeof paymentStatus)}
          >
            {PAYMENT_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="reservation-payment-method"
            label="Método de pagamento"
            required={paymentStatus !== "none"}
            disabled={paymentStatus === "none"}
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}
          >
            <option value="">Não informado</option>
            {PAYMENT_METHOD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </SelectField>

          <TextField
            id="reservation-override-total"
            label="Valor total (override, opcional)"
            type="number"
            min={0}
            step="0.01"
            value={overrideTotalReais}
            onChange={(e) => setOverrideTotalReais(e.target.value)}
          />
        </div>

        <TextField
          id="reservation-notes"
          label="Observações (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        {error && (
          <p role="alert" className="text-sm text-danger-500">
            {error}
          </p>
        )}

        <div className="flex gap-2 mt-2">
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Salvando..." : "Criar reserva"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </Card>
    </div>
  );
}
