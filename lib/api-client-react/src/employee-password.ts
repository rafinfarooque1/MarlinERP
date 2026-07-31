/**
 * Administrative password reset for an employee account.
 *
 * Hand-written rather than generated because the reset password itself is a
 * server-side constant. The response carries it back so the UI can display
 * exactly what the server set, instead of hardcoding the value here where it
 * would silently drift the day the server's constant changes.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export interface ResetEmployeePasswordResult {
  success: boolean;
  /** The employee's login name, echoed so the UI can show the full credential. */
  username: string;
  /** The password the account was reset to. */
  password: string;
  message: string;
}

export const useResetEmployeePassword = () => {
  const qc = useQueryClient();
  return useMutation<ResetEmployeePasswordResult, Error, { id: number }>({
    mutationFn: ({ id }) =>
      customFetch<ResetEmployeePasswordResult>(`/api/hr/employees/${id}/reset-password`, {
        method: "POST",
      }),
    // The reset clears must_change_password, which the employee list reads.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/hr/employees"] });
    },
  });
};
