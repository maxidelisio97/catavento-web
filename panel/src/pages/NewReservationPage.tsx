import { useEffect, useState } from "react";
import { createManualReservation, type CreateManualReservationInput } from "../api/manualReservation";
import { getFreeUnits, getRoomTypes, type RoomFreeUnit, type RoomType } from "../api/rooms";
import type { ReservationDetail } from "../api/tapeChart";
import { ApiError } from "../api/client";
import { todayISO, addDaysUTC, formatDateUTC, parseDateUTC } from "../lib/dateUtils";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { TextField, SelectField } from "../components/ui/Field";
import DatePicker from "../components/ui/DatePicker";
import UnitPicker from "../components/reservations/UnitPicker";

// SDD "Nova reserva" panel change. PR 3a shipped the form skeleton + any-unit
// submission (every submit sent `preferred_room_unit_id: undefined`,
// byte-identical to today's manual-reservation behavior). PR 3b (this file,
// now) adds the specific-unit picker plus the two conflict/warning flows the
// picker makes reachable: 409 PREFERRED_UNIT_TAKEN and 422
// COMMERCIAL_WARNING. Field list frozen to exactly what
// `panelManualReservation.ts` accepts — see `api/manualReservation.ts`.
//
// Size reference: CashMovementFormPage.tsx (closest existing form of
// comparable shape/complexity in this codebase).

interface CommercialWarning {
  code: string;
  message: string;
}

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
  const [rooms, setRooms] = useState<RoomType[] | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);

  const [roomId, setRoomId] = useState("");
  const [checkIn, setCheckIn] = useState(todayISO());
  const [checkOut, setCheckOut] = useState(formatDateUTC(addDaysUTC(parseDateUTC(todayISO()), 1)));

  // Unit picker (T3.4/T3.5 remainder) — null means "Qualquer unidade" (no
  // preference), the same as omitting `preferred_room_unit_id` entirely.
  const [freeUnits, setFreeUnits] = useState<RoomFreeUnit[] | null>(null);
  const [freeUnitsLoading, setFreeUnitsLoading] = useState(false);
  const [freeUnitsError, setFreeUnitsError] = useState<string | null>(null);
  const [preferredUnitId, setPreferredUnitId] = useState<number | null>(null);
  // 409 PREFERRED_UNIT_TAKEN / 404 PREFERRED_UNIT_NOT_FOUND surface here,
  // scoped to the picker — distinct from the form-wide `error` below so a
  // unit conflict doesn't read like a generic submit failure.
  const [unitError, setUnitError] = useState<string | null>(null);

  // 422 COMMERCIAL_WARNING two-step confirm, mirroring ReservationDrawer's
  // moveDatesStep state machine (design § "Panel form structure"). `pendingPayload`
  // freezes the exact payload that triggered the warning so "Confirmar mesmo
  // assim" resubmits byte-identical data plus `force_commercial: true`.
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [commercialWarnings, setCommercialWarnings] = useState<CommercialWarning[]>([]);
  const [pendingPayload, setPendingPayload] = useState<CreateManualReservationInput | null>(null);

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
    getRoomTypes()
      .then((data) => {
        if (!cancelled) setRooms(data.rooms);
      })
      .catch(() => {
        if (!cancelled) setRoomsError("Não foi possível carregar os tipos de quarto.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-fetches free units whenever room type or dates change (T3.5
  // remainder). Invalid ranges (checkOut <= checkIn) never hit the network —
  // same client-side guard as the submit handler. Resets any previously
  // chosen unit back to "Qualquer unidade": a unit id picked for a different
  // room/date combo has no meaning here, and silently keeping it selected
  // would be exactly the "silent substitution" the design forbids.
  useEffect(() => {
    setPreferredUnitId(null);
    setUnitError(null);

    if (!roomId || checkOut <= checkIn) {
      setFreeUnits(null);
      setFreeUnitsError(null);
      return;
    }

    let cancelled = false;
    setFreeUnitsLoading(true);
    setFreeUnitsError(null);
    getFreeUnits(Number(roomId), checkIn, checkOut)
      .then((result) => {
        if (!cancelled) setFreeUnits(result.units);
      })
      .catch(() => {
        if (!cancelled) setFreeUnitsError("Não foi possível carregar as unidades.");
      })
      .finally(() => {
        if (!cancelled) setFreeUnitsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, checkIn, checkOut]);

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

  // Re-used by both the 409 PREFERRED_UNIT_TAKEN and 404
  // PREFERRED_UNIT_NOT_FOUND handlers (design § "409 PREFERRED_UNIT_TAKEN":
  // refetch free-units, reopen the picker). Never auto-retries the POST —
  // this only refreshes the picker's data, staff must pick and submit again.
  function refetchFreeUnits() {
    if (!roomId || checkOut <= checkIn) return;
    setFreeUnitsLoading(true);
    setFreeUnitsError(null);
    getFreeUnits(Number(roomId), checkIn, checkOut)
      .then((result) => setFreeUnits(result.units))
      .catch(() => setFreeUnitsError("Não foi possível carregar as unidades."))
      .finally(() => setFreeUnitsLoading(false));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setUnitError(null);

    if (!roomId) {
      setError("Selecione um tipo de quarto.");
      return;
    }
    if (checkOut <= checkIn) {
      // Client-side equivalent of the GET free-units endpoint's
      // INVALID_DATE_RANGE — the manual-reservation POST itself has no such
      // error code, so this never reaches the server.
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

    const payload: CreateManualReservationInput = {
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
      // null ("Qualquer unidade") maps to omitting the field entirely —
      // byte-identical to the pre-picker PR 3a behavior (auto-assign
      // freeUnits[0]).
      preferred_room_unit_id: preferredUnitId ?? undefined,
    };

    setSaving(true);
    try {
      const detail = await createManualReservation(payload);
      onSaved(detail);
    } catch (err) {
      handleSubmitError(err, payload);
    } finally {
      setSaving(false);
    }
  }

  // Shared between the initial submit and the post-confirm resubmit — same
  // error taxonomy applies either way (design § "409 PREFERRED_UNIT_TAKEN" /
  // "COMMERCIAL_WARNING").
  function handleSubmitError(err: unknown, payload: CreateManualReservationInput) {
    if (err instanceof ApiError && err.status === 422 && err.message === "COMMERCIAL_WARNING") {
      const warnings = (err.details as { warnings?: CommercialWarning[] } | undefined)?.warnings ?? [];
      setCommercialWarnings(warnings);
      setPendingPayload(payload);
      setStep("confirm");
      return;
    }
    if (err instanceof ApiError && err.status === 409 && err.message === "PREFERRED_UNIT_TAKEN") {
      // Never auto-retry (design § "409 PREFERRED_UNIT_TAKEN") — refresh the
      // picker and let staff choose again explicitly.
      setStep("form");
      setUnitError("A unidade escolhida acabou de ser ocupada. Selecione outra.");
      setPreferredUnitId(null);
      refetchFreeUnits();
      return;
    }
    if (err instanceof ApiError && err.status === 404 && err.message === "PREFERRED_UNIT_NOT_FOUND") {
      setStep("form");
      setUnitError("A unidade escolhida não está mais disponível para este tipo de quarto.");
      setPreferredUnitId(null);
      refetchFreeUnits();
      return;
    }
    if (err instanceof ApiError && err.status === 409 && err.message === "NO_AVAILABILITY") {
      setStep("form");
      setError("Não há disponibilidade para este quarto nas datas selecionadas.");
      return;
    }
    if (err instanceof ApiError && err.status === 404 && err.message === "ROOM_NOT_FOUND") {
      setStep("form");
      setError("Este tipo de quarto não está mais disponível.");
      return;
    }
    setStep("form");
    setError("Erro inesperado ao criar a reserva.");
  }

  // 422 COMMERCIAL_WARNING confirm step — resubmits the EXACT payload that
  // triggered the warning, plus `force_commercial: true` (design §
  // "Commercial warning retry preserved" spec scenario). A fresh
  // PREFERRED_UNIT_TAKEN/NOT_FOUND discovered even after confirming still
  // routes back to the form, never silently substitutes another unit.
  async function handleConfirmCommercialWarning() {
    if (!pendingPayload) return;
    setSaving(true);
    setError(null);
    try {
      const detail = await createManualReservation({ ...pendingPayload, force_commercial: true });
      onSaved(detail);
    } catch (err) {
      handleSubmitError(err, pendingPayload);
    } finally {
      setSaving(false);
    }
  }

  function handleCancelCommercialWarning() {
    setStep("form");
    setCommercialWarnings([]);
    setPendingPayload(null);
  }

  if (step === "confirm") {
    return (
      <div className="max-w-2xl">
        <Card className="p-6 flex flex-col gap-3">
          <h2 className="text-[15px] font-semibold text-panel-900">Confirmar reserva</h2>
          <p className="text-sm text-panel-700">
            O sistema encontrou os seguintes avisos comerciais para esta reserva. Confirme para criar a reserva mesmo
            assim, ou volte para ajustar os dados.
          </p>
          <ul className="text-xs text-warning-700 bg-warning-50 rounded-panel-sm px-2 py-1.5 flex flex-col gap-1">
            {commercialWarnings.map((warning) => (
              <li key={warning.code}>{warning.message}</li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="text-sm text-danger-500">
              {error}
            </p>
          )}
          <div className="flex gap-2 mt-1">
            <Button variant="primary" disabled={saving} onClick={handleConfirmCommercialWarning}>
              {saving ? "Salvando..." : "Confirmar mesmo assim"}
            </Button>
            <Button disabled={saving} onClick={handleCancelCommercialWarning}>
              Voltar
            </Button>
          </div>
        </Card>
      </div>
    );
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
              <option key={room.id} value={room.id}>
                {room.name}
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

        <UnitPicker
          units={freeUnits}
          loading={freeUnitsLoading}
          error={freeUnitsError ?? unitError}
          value={preferredUnitId}
          onChange={setPreferredUnitId}
        />

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
