---
name: shadcn FormItem/FormLabel need FormField context
description: Using form.tsx primitives outside a FormField render prop crashes the whole page at runtime
---

`FormItem`, `FormLabel`, `FormControl`, `FormMessage` from `components/ui/form.tsx` all call `useFormField()`, which throws `useFormField should be used within <FormField>` if rendered outside a `<FormField render={...}>`. The crash takes down the ENTIRE route (error overlay in dev, blank page after dismiss) — it is not a cosmetic warning, and tsc does not catch it.

**How to apply:** for UI-only controls that are not react-hook-form fields (a filter select, a party-type switcher, a label over a custom widget like AttachmentField), use a plain `<div className="space-y-2">` + `<label className="text-sm font-medium leading-none">`, never FormItem/FormLabel. Only fields wired through `form.control` get the Form* primitives.
