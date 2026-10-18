"use client";

import { useState, useMemo } from "react";
import {
  Box, Button, Grid, TextField, Typography,
  FormControl, InputLabel, Select, MenuItem,
  Snackbar, Alert, FormHelperText,
} from "@mui/material";
import { useRouter } from "next/navigation";
import { getNames } from "country-list";
import PhoneInput from "react-phone-input-2";
import "react-phone-input-2/lib/style.css";
import { useAuth } from "@/app/hooks/useAuth";
import AccountLayout from "@/app/shared-components/AccountLayout";
import AccountLoadingGate from "@/app/shared-components/AccountLoadingGate";
import { normalizePhoneNumber, isValidE164 } from "@/lib/phone";

const toInputDate = (isoDate: string) => {
  if (!isoDate) return "";
  const parts = isoDate.split("/");
  if (parts.length === 3 && parts[2].length === 4) {
    const [d, m, y] = parts;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const d = new Date(isoDate);
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
};

const FIELD_SX = {
  "& .MuiInputBase-root:before": { borderBottomColor: "#ccc" },
  "& .MuiInputBase-root:hover:not(.Mui-disabled):before": { borderBottomColor: "#999" },
  "& .MuiInputBase-root:after": { borderBottomColor: "black" },
};

const SELECT_SX = {
  "&::before": { borderBottomColor: "#ccc" },
  "&:hover:not(.Mui-disabled, .Mui-error):before": { borderBottomColor: "#999" },
  "&::after": { borderBottomColor: "black" },
};

export default function EditProfilePage() {
  const router = useRouter();
  const countryOptions = useMemo(() => getNames().sort(), []);
  const { user, status, update } = useAuth();

  const [saving, setSaving] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: "success" | "error" }>
    ({ open: false, message: "", severity: "success" });

  // react-phone-input-2 works with digits only (no "+") — strip it from the
  // stored E.164 value for display; normalizePhoneNumber re-adds it on save.
  const [form, setForm] = useState(() => ({
    firstName: user?.firstName || "",
    lastName:  user?.lastName  || "",
    username:  user?.username  || "",
    email:     user?.email     || "",
    country:   user?.country   || "Singapore",
    sex:       user?.sex       || "",
    dob:       user?.dob ? toInputDate(user.dob) : "",
    address:   user?.address   || "",
    phoneNumber: user?.phoneNumber?.replace(/^\+/, "") || "",
  }));
  // Only sent (and only shown) when the email is being changed — the API
  // requires it then. See PUT /api/user.
  const [currentPassword, setCurrentPassword] = useState("");
  const emailChanged = form.email !== (user?.email ?? "");
  const [phoneError, setPhoneError] = useState(false);

  const handleChange = (field: string, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    const normalizedPhone = form.phoneNumber ? normalizePhoneNumber(form.phoneNumber) : null;
    if (normalizedPhone && !isValidE164(normalizedPhone)) {
      setPhoneError(true);
      return;
    }
    setPhoneError(false);
    setSaving(true);
    try {
      const res = await fetch("/api/user", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          dob: form.dob ? form.dob.split("T")[0] : null,
          phoneNumber: normalizedPhone,
          ...(emailChanged ? { currentPassword } : {}),
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        // 4xx errors carry a message meant for the user (wrong current
        // password, email already in use, ...) — show it as-is.
        if (res.status < 500 && result.error) {
          setSnackbar({ open: true, message: result.error, severity: "error" });
          return;
        }
        throw new Error(result.error || "Update failed");
      }
      await update();
      const phoneChanged = normalizedPhone !== (user?.phoneNumber ?? null);
      setSnackbar({
        open: true,
        message: phoneChanged
          ? "Profile updated. Verify your new phone number on the Verification page."
          : "Profile updated successfully!",
        severity: "success",
      });
      setTimeout(() => router.replace("/profile"), 1200);
    } catch (err) {
      console.error(err);
      setSnackbar({ open: true, message: "Failed to update profile. Please try again.", severity: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") {
    return <AccountLoadingGate />;
  }

  if (!user) {
    return (
      <AccountLayout>
        <Box sx={{ py: 6 }}>
          <Typography textAlign="center" color="text.secondary">Please sign in to edit your profile.</Typography>
        </Box>
      </AccountLayout>
    );
  }

  return (
    <AccountLayout>
      <Typography component="h1" sx={{ fontSize: { xs: 24, md: 28 }, fontWeight: 800, letterSpacing: "-0.5px", mb: 3 }}>
        Edit Profile
      </Typography>

      <Box sx={{ bgcolor: "#fff", borderRadius: 2.5, border: "1px solid #c9cdd4", overflow: "hidden" }}>
        <Box sx={{ px: 3, py: 2, borderBottom: "1px solid #c9cdd4" }}>
          <Typography sx={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>Personal Information</Typography>
        </Box>

        <Box sx={{ px: 3, py: 3 }}>
          <Grid container spacing={3}>
            {([
              { label: "First Name", field: "firstName" },
              { label: "Last Name",  field: "lastName"  },
              { label: "Username",   field: "username"  },
              { label: "Email",      field: "email"     },
            ] as const).map(({ label, field }) => (
              <Grid size={{ xs: 12, sm: 6 }} key={field}>
                <TextField
                  fullWidth
                  label={label}
                  variant="standard"
                  value={form[field]}
                  onChange={(e) => handleChange(field, e.target.value)}
                  slotProps={{ inputLabel: { shrink: true } }}
                  sx={FIELD_SX}
                />
              </Grid>
            ))}

            {emailChanged && (
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  label="Current Password"
                  type="password"
                  autoComplete="current-password"
                  helperText="Required to change your email. Leave blank if you sign in with Google."
                  variant="standard"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  slotProps={{ inputLabel: { shrink: true } }}
                  sx={FIELD_SX}
                />
              </Grid>
            )}

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl fullWidth variant="standard">
                <InputLabel shrink>Country</InputLabel>
                <Select value={form.country} onChange={(e) => handleChange("country", e.target.value)} sx={SELECT_SX}>
                  {countryOptions.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <FormControl fullWidth variant="standard">
                <InputLabel shrink>Sex</InputLabel>
                <Select value={form.sex} onChange={(e) => handleChange("sex", e.target.value)} sx={SELECT_SX}>
                  <MenuItem value="Male">Male</MenuItem>
                  <MenuItem value="Female">Female</MenuItem>
                  <MenuItem value="Other">Other</MenuItem>
                </Select>
              </FormControl>
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth variant="standard" label="Date of Birth" type="date"
                value={form.dob}
                onChange={(e) => handleChange("dob", e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={FIELD_SX}
              />
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField
                fullWidth variant="standard" label="Address"
                value={form.address}
                onChange={(e) => handleChange("address", e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={FIELD_SX}
              />
            </Grid>

            <Grid size={{ xs: 12, sm: 6 }}>
              <Typography sx={{ fontSize: 12, color: "#6b7280", mb: 0.5 }}>Phone Number</Typography>
              <PhoneInput
                country={"sg"}
                value={form.phoneNumber}
                onChange={(value) => handleChange("phoneNumber", value)}
                inputStyle={{ width: "100%", height: "40px" }}
              />
              {phoneError && <FormHelperText error>Enter a valid phone number</FormHelperText>}
              {user?.phoneNumber && (
                <FormHelperText>
                  Changing this resets phone verification — you&apos;ll need to verify again.
                </FormHelperText>
              )}
            </Grid>
          </Grid>

          <Box sx={{ display: "flex", gap: 1.5, mt: 4, justifyContent: "flex-end" }}>
            <Button
              variant="outlined"
              onClick={() => router.back()}
              sx={{ textTransform: "none", fontWeight: 600, borderRadius: 1.5, borderColor: "#c9cdd4", color: "#374151", "&:hover": { borderColor: "#6b7280", bgcolor: "#f9fafb" } }}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              disabled={saving}
              onClick={handleSave}
              sx={{ textTransform: "none", fontWeight: 700, borderRadius: 1.5, bgcolor: "#111827", "&:hover": { bgcolor: "#1f2937" }, "&.Mui-disabled": { bgcolor: "#111", opacity: 0.5 } }}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </Box>
        </Box>
      </Box>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={2500}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert onClose={() => setSnackbar((s) => ({ ...s, open: false }))} severity={snackbar.severity} variant="filled" sx={{ width: "100%" }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </AccountLayout>
  );
}
