const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

// Check Stripe key
if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY not found!');
    process.exit(1);
}

console.log('Stripe key found:', process.env.STRIPE_SECRET_KEY.substring(0, 15) + '...');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

// Important: raw body for webhooks
app.use((req, res, next) => {
    if (req.originalUrl === '/webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

app.use(cors());

// Simple in-memory store (upgradeable to database later)
const proUsers = new Set();
global.customerMap = new Map();

// Send email notification
async function sendNotification(subject, message) {
    if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) {
        console.log('Email not configured, skipping notification');
        return;
    }
    
    try {
        await resend.emails.send({
            from: 'SnapMark <onboarding@resend.dev>',
            to: process.env.ADMIN_EMAIL,
            subject: subject,
            html: `
                <h2>${subject}</h2>
                <p>${message}</p>
                <hr>
                <small>SnapMark Backend Notification</small>
            `
        });
        console.log('Email notification sent');
    } catch (err) {
        console.error('Email error:', err);
    }
}

// Test route
app.get('/', (req, res) => {
    res.json({ 
        service: 'SnapMark Payment Backend',
        status: 'running'
    });
});

// Check if user is Pro
app.get('/check-pro/:userId', (req, res) => {
    const { userId } = req.params;
    const isPro = proUsers.has(userId);
    console.log('Checking pro status for:', userId, isPro);
    res.json({ isPro });
});

// Create Stripe checkout session
app.post('/create-checkout', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }
        
        console.log('Creating checkout for user:', userId);
        
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            customer_email: `${userId}@snapmark.temp`,
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'SnapMark Pro',
                        description: 'Unlimited screenshots per day',
                    },
                    unit_amount: 299, // $2.99 in cents
                    recurring: {
                        interval: 'month'
                    }
                },
                quantity: 1
            }],
            metadata: {
                userId: userId
            },
            client_reference_id: userId,
            success_url: `${process.env.FRONTEND_URL || 'https://snapmark-success.netlify.app'}?success=true&userId=${userId}`,
            cancel_url: `${process.env.FRONTEND_URL || 'https://snapmark-success.netlify.app'}?cancelled=true`
        });
        
        console.log('Checkout session created:', session.id);
        res.json({ url: session.url });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Stripe webhook - called when payment succeeds
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log('Webhook event:', event.type);
    
    // Payment succeeded - upgrade user to Pro and save customer ID
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const customerId = session.customer;
        const amount = session.amount_total / 100;
        
        if (userId && customerId) {
            proUsers.add(userId);
            global.customerMap.set(userId, customerId);
            
            console.log('User upgraded to Pro:', userId);
            console.log('Customer ID saved:', customerId);
            
            // Send notification
            await sendNotification(
                '💰 New SnapMark Pro Subscription!',
                `<strong>User ID:</strong> ${userId}<br>
                 <strong>Customer ID:</strong> ${customerId}<br>
                 <strong>Amount:</strong> $${amount}<br>
                 <strong>Time:</strong> ${new Date().toLocaleString()}`
            );
        }
    }
    
    // Subscription cancelled - downgrade user
    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        
        // Find userId by customerId
        for (let [userId, cId] of global.customerMap.entries()) {
            if (cId === customerId) {
                proUsers.delete(userId);
                console.log('User downgraded from Pro:', userId);
                break;
            }
        }
    }
    
    res.json({ received: true });
});

// Cancel subscription
app.post('/cancel-subscription', async (req, res) => {
    try {
        const { userId } = req.body;
        
        proUsers.delete(userId);
        console.log('Subscription cancelled for:', userId);
        
        // Send notification
        await sendNotification(
            '❌ SnapMark Subscription Cancelled',
            `<strong>User ID:</strong> ${userId}<br>
             <strong>Time:</strong> ${new Date().toLocaleString()}`
        );
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Stripe customer portal session
app.post('/create-portal-session', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }
        
        console.log('===== PORTAL SESSION REQUEST =====');
        console.log('Looking for customer with userId:', userId);
        
        // Try method 1: Search by metadata
        try {
            const customers = await stripe.customers.search({
                query: `metadata['userId']:'${userId}'`,
            });
            
            console.log('Search by metadata found:', customers.data.length, 'customers');
            
            if (customers.data.length > 0) {
                const customerId = customers.data[0].id;
                console.log('Using customer ID:', customerId);
                
                const session = await stripe.billingPortal.sessions.create({
                    customer: customerId,
                    return_url: `${process.env.FRONTEND_URL || 'https://snapmark-success.netlify.app'}?portal=closed`,
                });
                
                console.log('Portal session created successfully');
                return res.json({ url: session.url });
            }
        } catch (searchErr) {
            console.error('Search error:', searchErr);
        }
        
        // Try method 2: Check in-memory map
        console.log('Trying in-memory customerMap...');
        const customerId = global.customerMap?.get(userId);
        console.log('In-memory customer ID:', customerId);
        
        if (customerId) {
            const session = await stripe.billingPortal.sessions.create({
                customer: customerId,
                return_url: `${process.env.FRONTEND_URL || 'https://snapmark-success.netlify.app'}?portal=closed`,
            });
            
            console.log('Portal session created from memory');
            return res.json({ url: session.url });
        }
        
        // Try method 3: List all customers with this email
        console.log('Trying email search...');
        const customerList = await stripe.customers.list({
            email: `${userId}@snapmark.temp`,
            limit: 1
        });
        
        console.log('Email search found:', customerList.data.length);
        
        if (customerList.data.length > 0) {
            const session = await stripe.billingPortal.sessions.create({
                customer: customerList.data[0].id,
                return_url: `${process.env.FRONTEND_URL || 'https://snapmark-success.netlify.app'}?portal=closed`,
            });
            
            return res.json({ url: session.url });
        }
        
        console.log('No customer found by any method');
        return res.status(404).json({ error: 'No active subscription found. Please contact support or subscribe again.' });
        
    } catch (err) {
        console.error('Portal error:', err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log('SnapMark Payment Backend running on port', PORT);
    console.log('Server is ready to accept connections');
    console.log('Pro users in memory:', proUsers.size);
});
