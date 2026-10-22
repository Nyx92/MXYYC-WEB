"use client";
import { useState, useMemo } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from "@mui/material";
import DescriptionBar, {
  DescriptionLabel,
} from "../../shared-components/DescriptionBar";
import PhoneInput from "react-phone-input-2";
import "react-phone-input-2/lib/style.css";
import { getNames } from "country-list";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { FULL_VIEWPORT_HEIGHT } from "@/app/utils/uiScale";

// Reuse the same Google icon from the login page.
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// "User Profile" and "FAQ" removed — both linked to "" (nowhere), a dead
// no-op click. Only "Login" actually goes somewhere.
const descriptionBarLabels: DescriptionLabel[] = [
  { title: "", link: "" },
  { button: "Login", link: "/auth/login" },
];

export default function UserProfileForm() {
  const router = useRouter();
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    username: "",
    password: "",
    confirmPassword: "",
    country: "Singapore",
    sex: "",
    dob: "",
    address: "",
    phoneNumber: "",
  });

  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({
    passwordMismatch: false,
    passwordTooShort: false,
    phoneInvalid: false,
  });

  const countryOptions = useMemo(() => getNames().sort(), []);

  const handleChange = (name: string, value: string) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setErrors({
      passwordMismatch: false,
      passwordTooShort: false,
      phoneInvalid: false,
    });

    // ✅ Validation
    if (formData.password.length < 10) {
      setErrors((prev) => ({ ...prev, passwordTooShort: true }));
      setLoading(false);
      return;
    }
    if (formData.password !== formData.confirmPassword) {
      setErrors((prev) => ({ ...prev, passwordMismatch: true }));
      setLoading(false);
      return;
    }
    if (formData.phoneNumber && !/^\d+$/.test(formData.phoneNumber)) {
      setErrors((prev) => ({ ...prev, phoneInvalid: true }));
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || "Something went wrong");
      }

      alert("✅ Account created successfully!");
      console.log(result.user);

      // ✅ Redirect after success
      router.push("/auth/login");
    } catch (err) {
      console.error("❌ Registration failed:", err);
      const message = err instanceof Error ? err.message : "Failed to create account.";
      alert(message);
    }

    setLoading(false);
  };

  return (
    <Box
      sx={{
        backgroundColor: "#f5f5f7",
        display: "flex",
        flexDirection: "column",
        minHeight: FULL_VIEWPORT_HEIGHT,
      }}
    >
      <DescriptionBar labels={descriptionBarLabels} />

      <Box
        sx={{
          backgroundColor: "#f5f5f7",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          pb: 8,
        }}
      >
        <Typography
          variant="h2"
          component="h1"
          sx={{
            fontWeight: "bold",
            fontSize: { xs: "24px", lg: "32px" },
            mt: 4,
            mb: 3,
          }}
        >
          Create Your Profile
        </Typography>

        {loading ? (
          <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", py: 6 }}>
            <CircularProgress />
            <Typography sx={{ mt: 2 }}>Please wait...</Typography>
          </Box>
        ) : (
          <Box
            component="form"
            onSubmit={handleSubmit}
            sx={{
              width: { xs: "90%", sm: "80%", md: "60%", lg: "40%" },
              backgroundColor: "white",
              p: 3,
              borderRadius: 2,
              boxShadow: 1,
            }}
          >
            {/* Google sign-up */}
            <Button
              fullWidth
              variant="outlined"
              onClick={() => signIn("google", { callbackUrl: "/" })}
              startIcon={<GoogleIcon />}
              sx={{
                textTransform: "none",
                fontWeight: 500,
                fontSize: 15,
                borderColor: "#dadce0",
                color: "#3c4043",
                py: 1.2,
                mb: 1,
                "&:hover": { borderColor: "#d2e3fc", backgroundColor: "rgba(66,133,244,0.04)" },
              }}
            >
              Sign up with Google
            </Button>

            <Divider sx={{ my: 2 }}>
              <Typography sx={{ color: "#6b7280", fontSize: 13, px: 1 }}>
                or sign up with email
              </Typography>
            </Divider>

            {/* Name Fields — stacked on mobile, side by side from sm up
                (two fullWidth fields in a fixed row get too cramped below ~600px) */}
            <Box sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" }, gap: 2 }}>
              <TextField
                required
                fullWidth
                label="First Name"
                value={formData.firstName}
                onChange={(e) => handleChange("firstName", e.target.value)}
                slotProps={{
                  inputLabel: {
                    shrink: true,
                  },
                }}
              />
              <TextField
                required
                fullWidth
                label="Last Name"
                value={formData.lastName}
                onChange={(e) => handleChange("lastName", e.target.value)}
                slotProps={{
                  inputLabel: {
                    shrink: true,
                  },
                }}
              />
            </Box>

            {/* Email */}
            <TextField
              required
              fullWidth
              margin="normal"
              label="Email"
              type="email"
              value={formData.email}
              onChange={(e) => handleChange("email", e.target.value)}
              slotProps={{
                inputLabel: {
                  shrink: true,
                },
              }}
            />

            {/* Username */}
            <TextField
              required
              fullWidth
              margin="normal"
              label="Username"
              type="username"
              value={formData.username}
              onChange={(e) => handleChange("username", e.target.value)}
              slotProps={{
                inputLabel: {
                  shrink: true,
                },
              }}
            />

            {/* Passwords */}
            <TextField
              required
              fullWidth
              margin="normal"
              label="Password"
              type="password"
              value={formData.password}
              error={errors.passwordTooShort}
              helperText={
                errors.passwordTooShort
                  ? "Password must be at least 10 characters"
                  : ""
              }
              onChange={(e) => handleChange("password", e.target.value)}
              slotProps={{
                inputLabel: {
                  shrink: true,
                },
              }}
            />
            <TextField
              required
              fullWidth
              margin="normal"
              label="Confirm Password"
              type="password"
              value={formData.confirmPassword}
              error={errors.passwordMismatch}
              helperText={
                errors.passwordMismatch ? "Passwords do not match" : ""
              }
              onChange={(e) => handleChange("confirmPassword", e.target.value)}
              slotProps={{
                inputLabel: {
                  shrink: true,
                },
              }}
            />

            {/* Country */}
            <FormControl fullWidth margin="normal">
              <InputLabel>Country / Region</InputLabel>
              <Select
                value={formData.country}
                label="Country / Region"
                onChange={(e) => handleChange("country", e.target.value)}
              >
                {countryOptions.map((country) => (
                  <MenuItem key={country} value={country}>
                    {country}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* Sex Dropdown */}
            <FormControl fullWidth margin="normal" required>
              <InputLabel>Sex</InputLabel>
              <Select
                value={formData.sex}
                label="Sex"
                onChange={(e) => handleChange("sex", e.target.value)}
              >
                <MenuItem value="Male">Male</MenuItem>
                <MenuItem value="Female">Female</MenuItem>
                <MenuItem value="Other">Other</MenuItem>
              </Select>
            </FormControl>

            {/* Date of Birth */}
            <TextField
              required
              fullWidth
              margin="normal"
              label="Date of Birth"
              type="date"
              value={formData.dob}
              onChange={(e) => handleChange("dob", e.target.value)}
              slotProps={{
                inputLabel: {
                  shrink: true,
                },
              }}
            />

            {/* Address */}
            <TextField
              fullWidth
              margin="normal"
              label="Address"
              value={formData.address}
              onChange={(e) => handleChange("address", e.target.value)}
              slotProps={{
                inputLabel: {
                  shrink: true,
                },
              }}
            />

            {/* Phone */}
            <Box sx={{ mt: 2 }}>
              <PhoneInput
                country={"sg"}
                value={formData.phoneNumber}
                onChange={(value) => handleChange("phoneNumber", value)}
                inputStyle={{
                  width: "100%",
                  height: "56px",
                  borderRadius: "4px",
                  border: "1px solid rgba(0, 0, 0, 0.23)",
                }}
              />
              {errors.phoneInvalid && (
                <FormHelperText error>
                  Please enter a valid phone number
                </FormHelperText>
              )}
            </Box>

            {/* Submit */}
            <Button
              type="submit"
              fullWidth
              variant="contained"
              sx={{
                mt: 3,
                textTransform: "none",
                backgroundColor: "black",
                color: "white",
                "&:hover": { backgroundColor: "#222" },
              }}
            >
              Create Account
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}
