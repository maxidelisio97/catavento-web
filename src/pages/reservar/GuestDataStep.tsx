/*
 * Paso 3 de /reservar: dados do hospede. Validacao no cliente espelha a
 * do backend (mesmos limites do Zod em plugins/reservations.ts).
 */
import { useState } from "react";
import { LuArrowLeft, LuCircleAlert } from "react-icons/lu";
import { ApiError, createReservation, type AvailabilityRoom, type ReservationResponse } from "../../lib/api";
import { formatCents, formatIsoDateLabel } from "./formatters";

interface GuestDataStepProps {
  room: AvailabilityRoom;
  checkIn: string;
  checkOut: string;
  guests: number;
  children: number;
  babies: number;
  childrenAges: number[];
  onBack: () => void;
  onSuccess: (reservation: ReservationResponse) => void;
  onNoAvailability: () => void;
}

type FieldErrors = Partial<Record<"name" | "email" | "phone", string>>;

export default function GuestDataStep({
  room,
  checkIn,
  checkOut,
  guests,
  children,
  babies,
  childrenAges,
  onBack,
  onSuccess,
  onNoAvailability,
}: GuestDataStepProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (name.trim().length < 3) errors.name = "Digite seu nome completo.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Digite um e-mail válido.";
    if (phone.replace(/\D/g, "").length < 8) errors.phone = "Digite um telefone/WhatsApp válido.";
    return errors;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setFormError(null);
    setSubmitting(true);
    try {
      const reservation = await createReservation({
        room_id: room.room_id,
        check_in: checkIn,
        check_out: checkOut,
        adults: guests,
        children,
        babies,
        childrenAges,
        guest_name: name.trim(),
        guest_email: email.trim(),
        guest_phone: phone.trim(),
        notes: notes.trim() || undefined,
      });
      onSuccess(reservation);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onNoAvailability();
        return;
      }
      setFormError(err instanceof ApiError ? err.message : "Não conseguimos concluir a reserva. Tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-xl border border-stone-300 bg-white px-4 py-3 font-body text-sm text-warm-900 placeholder:text-warm-800/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400";
  const labelClass = "block font-body text-xs font-semibold uppercase tracking-[0.1em] text-warm-800/60 mb-1.5";

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full max-w-md mx-auto space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 font-body text-sm text-warm-800/60 hover:text-coral-600 transition-colors"
      >
        <LuArrowLeft size={16} aria-hidden />
        Escolher outro quarto
      </button>

      <div>
        <h2 className="font-heading text-2xl text-warm-900">Seus dados</h2>
        <p className="mt-1 font-body text-sm text-warm-800/60">
          {room.name} · {formatIsoDateLabel(checkIn)} — {formatIsoDateLabel(checkOut)} ·{" "}
          {room.total_cents != null ? formatCents(room.total_cents) : ""}
        </p>
      </div>

      <div>
        <label htmlFor="guest-name" className={labelClass}>
          Nome completo
        </label>
        <input
          id="guest-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={Boolean(fieldErrors.name)}
          className={inputClass}
        />
        {fieldErrors.name && <FieldError message={fieldErrors.name} />}
      </div>

      <div>
        <label htmlFor="guest-email" className={labelClass}>
          E-mail
        </label>
        <input
          id="guest-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(fieldErrors.email)}
          className={inputClass}
        />
        {fieldErrors.email && <FieldError message={fieldErrors.email} />}
      </div>

      <div>
        <label htmlFor="guest-phone" className={labelClass}>
          Telefone / WhatsApp
        </label>
        <input
          id="guest-phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-invalid={Boolean(fieldErrors.phone)}
          className={inputClass}
        />
        {fieldErrors.phone && <FieldError message={fieldErrors.phone} />}
      </div>

      <div>
        <label htmlFor="guest-notes" className={labelClass}>
          Comentários (opcional)
        </label>
        <textarea
          id="guest-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, 500))}
          rows={3}
          className={inputClass}
        />
      </div>

      {formError && (
        <p role="alert" className="flex items-start gap-1.5 font-body text-sm text-coral-600">
          <LuCircleAlert size={16} className="shrink-0 mt-0.5" />
          <span>{formError}</span>
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full h-14 rounded-2xl bg-coral-600 hover:bg-coral-500 text-white font-body font-semibold transition-colors active:scale-[0.98] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-coral-400"
      >
        {submitting ? "Enviando…" : "Confirmar dados"}
      </button>
    </form>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-1.5 flex items-start gap-1.5 font-body text-xs text-coral-600">
      <LuCircleAlert size={13} className="shrink-0 mt-0.5" />
      <span>{message}</span>
    </p>
  );
}
