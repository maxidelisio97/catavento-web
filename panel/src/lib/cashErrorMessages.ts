// Same convention as lib/adminErrorMessages.ts: backend errors come back as
// bare codes (§ ApiError: body.error), never a human message.
const MESSAGES: Record<string, string> = {
  CATEGORY_NAME_ALREADY_EXISTS: "Já existe uma categoria com esse nome.",
  CATEGORY_NOT_FOUND: "Categoria não encontrada.",
  MOVEMENT_NOT_FOUND: "Movimento não encontrado.",
  EXPENSE_CATEGORY_ID_NOT_ALLOWED_FOR_INCOME: "Uma receita não pode ter categoria de despesa.",
  FORBIDDEN: "Você não tem permissão para essa ação.",
};

export function describeCashError(code: string): string {
  return MESSAGES[code] ?? "Erro inesperado.";
}
